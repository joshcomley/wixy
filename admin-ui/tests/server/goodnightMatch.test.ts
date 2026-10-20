import { describe, expect, it } from "vitest";
import { isGoodNight } from "../../src/server/goodnight/match";

const POSITIVE = [
  "good night",
  "Good night",
  "GOOD NIGHT",
  "goodnight",
  "Goodnight!",
  "good nite",
  "goodnite",
  "g'night",
  "G’night x",
  "gnight",
  "night night",
  "Night night \u{1F634}",
  "nite nite",
  "nighty night",
  "nighty nite",
  "nightnight",
  "niiight niiight",
  "goooodnight",
  "gooood niiight",
  "ok good night x",
  "have a good night's sleep",
  "Good night, sleep tight!",
  "\u{1F319} goodnight \u{1F319}",
  "good-night",
  "sweet dreams, good night.",
];

const NEGATIVE = [
  "",
  "gn",
  "GN",
  "tonight",
  "last night",
  "night out",
  "good morning",
  "goodbye",
  "what a night",
  "I'm out tonight",
  "knight",
  "nightmare",
  "midnight",
  "god night",
  "good tonight",
  "last night was good",
];

describe("isGoodNight", () => {
  it.each(POSITIVE)("matches %j", (text) => {
    expect(isGoodNight(text)).toBe(true);
  });

  it.each(NEGATIVE)("does not match %j", (text) => {
    expect(isGoodNight(text)).toBe(false);
  });

  it("handles no text", () => {
    expect(isGoodNight(null)).toBe(false);
    expect(isGoodNight(undefined)).toBe(false);
  });
});
