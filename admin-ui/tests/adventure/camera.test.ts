import { geoOrthographic } from "d3-geo";
import { describe, expect, it } from "vitest";
import {
  DETAIL_BELOW_DEG,
  MAX_VIEW_RADIUS_DEG,
  MIN_VIEW_RADIUS_DEG,
  angularDistanceDeg,
  cameraAt,
  cameraFromRotation,
  cameraRotation,
  centreOfRotation,
  clampViewRadius,
  fitCamera,
  greatCircleAt,
  meanPoint,
  normalizeLng,
  rollOfRotation,
  rotationFor,
  scaleFor,
  tweenCamera,
  viewRadiusForScale,
  wrapAngle,
  type Camera,
  type LngLat,
} from "../../src/server/adventure/camera";

function near(a: LngLat, b: LngLat, tol = 1e-6): void {
  expect(a[0]).toBeCloseTo(b[0], -Math.log10(tol));
  expect(a[1]).toBeCloseTo(b[1], -Math.log10(tol));
}

describe("angle helpers", () => {
  it("normalizeLng wraps into [-180, 180)", () => {
    expect(normalizeLng(190)).toBeCloseTo(-170, 9);
    expect(normalizeLng(-190)).toBeCloseTo(170, 9);
    expect(normalizeLng(540)).toBeCloseTo(-180, 9);
    expect(normalizeLng(0)).toBe(0);
    expect(normalizeLng(179.5)).toBeCloseTo(179.5, 9);
  });

  it("wrapAngle wraps into (-180, 180]", () => {
    expect(wrapAngle(190)).toBeCloseTo(-170, 9);
    expect(wrapAngle(-180)).toBe(180);
    expect(wrapAngle(180)).toBe(180);
    expect(wrapAngle(720)).toBe(0);
  });
});

describe("scaleFor", () => {
  it("shows the whole globe at 0.45 x the short side at a 90 degree view radius", () => {
    expect(scaleFor(90, 360, 740)).toBeCloseTo(162, 9);
    expect(scaleFor(90, 1280, 800)).toBeCloseTo(360, 9);
  });

  it("makes R sin(viewRadius) = 0.45 min(w, h) below 90 degrees", () => {
    for (const vr of [60, 30, 10, 3, 1.2, 0.3]) {
      const scale = scaleFor(vr, 400, 800);
      expect(scale * Math.sin((vr * Math.PI) / 180)).toBeCloseTo(0.45 * 400, 6);
    }
  });

  it("treats view radii beyond 90 as 90, and survives silly input", () => {
    expect(scaleFor(120, 400, 400)).toBeCloseTo(180, 9);
    expect(Number.isFinite(scaleFor(0, 400, 400))).toBe(true);
    expect(Number.isFinite(scaleFor(Number.NaN, 400, 400))).toBe(true);
  });

  it("is inverted by viewRadiusForScale", () => {
    for (const vr of [90, 45, 12, 1.2]) expect(viewRadiusForScale(scaleFor(vr, 360, 740), 360, 740)).toBeCloseTo(vr, 6);
    expect(viewRadiusForScale(10, 360, 740)).toBe(90);
    expect(viewRadiusForScale(0, 360, 740)).toBe(90);
  });

  it("clampViewRadius keeps within 0.3..90", () => {
    expect(clampViewRadius(0.01)).toBe(MIN_VIEW_RADIUS_DEG);
    expect(clampViewRadius(400)).toBe(MAX_VIEW_RADIUS_DEG);
    expect(clampViewRadius(Number.NaN)).toBe(MAX_VIEW_RADIUS_DEG);
    expect(DETAIL_BELOW_DEG).toBe(60);
  });
});

describe("rotations", () => {
  it("rotationFor centres the requested point", () => {
    const projection = geoOrthographic().rotate(rotationFor([12, 34])).scale(100).translate([0, 0]);
    const p = projection([12, 34]);
    expect(p?.[0]).toBeCloseTo(0, 9);
    expect(p?.[1]).toBeCloseTo(0, 9);
  });

  it("centreOfRotation matches [-lambda, -phi] inside the normal latitude range", () => {
    near(centreOfRotation([20, -15]), [-20, 15]);
    near(centreOfRotation([0, 0]), [0, 0]);
    near(centreOfRotation([-170, 80]), [170, -80]);
  });

  it("tumbles over the poles: phi = 120 deg looks at latitude -60 on the far meridian", () => {
    near(centreOfRotation([20, 120]), [160, -60]);
    expect(rollOfRotation([20, 120])).toBeCloseTo(180, 6);
  });

  it("copes with phi = -200 and phi = 450", () => {
    near(centreOfRotation([20, -200]), [160, -20]);
    expect(rollOfRotation([20, -200])).toBeCloseTo(180, 6);
    const pole = centreOfRotation([20, 450]);
    expect(pole[1]).toBeCloseTo(-90, 6);
    expect(rollOfRotation([20, 450])).toBeCloseTo(0, 4);
  });

  it("is periodic in phi (a full tumble is no tumble)", () => {
    near(centreOfRotation([33, 25]), centreOfRotation([33, 25 + 360]));
    near(centreOfRotation([33, 25]), centreOfRotation([33, 25 - 720]));
  });

  it("roll is 0 for any upright globe and follows gamma", () => {
    expect(rollOfRotation([40, -30])).toBe(0);
    expect(rollOfRotation([0, 0, 30])).toBeCloseTo(-30, 6);
    expect(rollOfRotation([0, 0, -30])).toBeCloseTo(30, 6);
  });

  it("a camera made from a tumbled rotation draws exactly the same picture", () => {
    for (const rotation of [
      [20, 120],
      [-75, -200],
      [10, 450],
      [5, 200],
      [170, 91],
    ] as const) {
      const raw = geoOrthographic().rotate([...rotation, 0]).scale(200).translate([300, 300]);
      const camera = cameraFromRotation(rotation, 90);
      const cam = geoOrthographic().rotate(cameraRotation(camera)).scale(200).translate([300, 300]);
      for (const point of [[0, 0], [30, 40], [-100, -20], [160, -60], [170, -50], [45, 85]] as const) {
        const a = raw([...point]);
        const b = cam([...point]);
        expect(a?.[0]).toBeCloseTo(b?.[0] ?? Number.NaN, 6);
        expect(a?.[1]).toBeCloseTo(b?.[1] ?? Number.NaN, 6);
      }
    }
  });
});

describe("meanPoint and fitCamera", () => {
  it("averages on the sphere, not on the map", () => {
    near(meanPoint([[170, 0], [-170, 0]]), [180, 0], 1e-6);
    near(meanPoint([[10, 0], [30, 0]]), [20, 0]);
    expect(meanPoint([[0, 80], [180, 80]])[1]).toBeCloseTo(90, 6); // over the pole, not along the 80th parallel
  });

  it("falls back to the first point when the points cancel out, and (0,0) for none", () => {
    expect(meanPoint([[0, 0], [180, 0]])[1]).toBeCloseTo(0, 6);
    expect(meanPoint([])).toEqual([0, 0]);
  });

  it("fits the farthest point x 1.25, clamped", () => {
    const centre: LngLat = [0, 0];
    const camera = fitCamera(centre, [[2, 0], [0, 4], [-1, 1]], 3, 40);
    expect(camera.centre).toBe(centre);
    expect(camera.viewRadiusDeg).toBeCloseTo(5, 6); // 4 deg x 1.25
    expect(fitCamera(centre, [[0.1, 0]], 3, 40).viewRadiusDeg).toBe(3); // min
    expect(fitCamera(centre, [[60, 0]], 3, 40).viewRadiusDeg).toBe(40); // max
    expect(fitCamera(centre, [], 1.5, 40).viewRadiusDeg).toBe(1.5);
  });

  it("measures the distance on the sphere", () => {
    expect(angularDistanceDeg([0, 0], [90, 0])).toBeCloseTo(90, 9);
    expect(angularDistanceDeg([179, 0], [-179, 0])).toBeCloseTo(2, 9);
    const camera = fitCamera([179, 0], [[-179, 0]], 1, 40);
    expect(camera.viewRadiusDeg).toBeCloseTo(2.5, 6);
  });
});

describe("tweenCamera", () => {
  const a: Camera = { centre: [0, 0], viewRadiusDeg: 90 };
  const b: Camera = { centre: [60, 0], viewRadiusDeg: 10, roll: 0 };

  it("returns the endpoints exactly", () => {
    expect(tweenCamera(a, b, 0)).toBe(a);
    expect(tweenCamera(a, b, 1)).toBe(b);
    expect(tweenCamera(a, b, -1)).toBe(a);
    expect(tweenCamera(a, b, 2)).toBe(b);
  });

  it("moves the centre along the great circle", () => {
    const mid = tweenCamera(a, b, 0.5);
    near(mid.centre, [30, 0]);
    const north = tweenCamera({ centre: [0, 0], viewRadiusDeg: 40 }, { centre: [0, 80], viewRadiusDeg: 40 }, 0.25);
    near(north.centre, [0, 20]);
  });

  it("goes the short way round the antimeridian", () => {
    const mid = tweenCamera({ centre: [170, 10], viewRadiusDeg: 20 }, { centre: [-170, 10], viewRadiusDeg: 20 }, 0.5);
    expect(Math.abs(Math.abs(mid.centre[0]) - 180)).toBeLessThan(0.1);
  });

  it("interpolates the view radius in log space", () => {
    expect(tweenCamera(a, b, 0.5).viewRadiusDeg).toBeCloseTo(Math.sqrt(90 * 10), 6);
    const quarter = tweenCamera(a, b, 0.25).viewRadiusDeg;
    expect(quarter).toBeCloseTo(90 * (10 / 90) ** 0.25, 6);
  });

  it("rights an upside-down globe the short way", () => {
    const upsideDown: Camera = { centre: [0, 0], viewRadiusDeg: 90, roll: 180 };
    const upright: Camera = { centre: [10, 0], viewRadiusDeg: 90, roll: 0 };
    expect(Math.abs(tweenCamera(upsideDown, upright, 0.5).roll ?? 0)).toBeCloseTo(90, 6);
    const small = tweenCamera({ ...a, roll: 170 }, { ...b, roll: -170 }, 0.5);
    expect(Math.abs(small.roll ?? 0)).toBeCloseTo(180, 6); // 170 -> 190, not back through 0
  });

  it("copes with identical and exactly opposite centres", () => {
    const same = tweenCamera({ centre: [5, 5], viewRadiusDeg: 30 }, { centre: [5, 5], viewRadiusDeg: 3 }, 0.5);
    near(same.centre, [5, 5]);
    const opposite = greatCircleAt([0, 0], [180, 0], 0.5);
    expect(Number.isFinite(opposite[0])).toBe(true);
    expect(Number.isFinite(opposite[1])).toBe(true);
    expect(angularDistanceDeg([0, 0], opposite)).toBeCloseTo(90, 3);
  });

  it("cameraAt eases in and out", () => {
    const early = cameraAt(a, b, 100, 1000).viewRadiusDeg;
    const linearEarly = tweenCamera(a, b, 0.1).viewRadiusDeg;
    expect(early).toBeGreaterThan(linearEarly); // eased: moved less than linear
    expect(cameraAt(a, b, 1000, 1000)).toBe(b);
    expect(cameraAt(a, b, 5000, 1000)).toBe(b);
    expect(cameraAt(a, b, 0, 1000)).toBe(a);
    expect(cameraAt(a, b, 10, 0)).toBe(b);
  });
});
