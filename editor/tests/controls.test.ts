import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHoursControl,
  buildPriceControl,
  buildQaControl,
  parseHoursValue,
  parsePriceList,
  serializeHoursValue,
  serializePriceList,
} from "../src/controls";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("parseHoursValue / serializeHoursValue", () => {
  it("parses a time pair (em-dash, en-dash, hyphen tolerant)", () => {
    expect(parseHoursValue("10:00 – 19:00")).toEqual({ from: "10:00", to: "19:00" });
    expect(parseHoursValue("9:30—17:00")).toEqual({ from: "9:30", to: "17:00" });
    expect(parseHoursValue("11:00 - 16:00")).toEqual({ from: "11:00", to: "16:00" });
  });

  it("returns null for free-text values", () => {
    expect(parseHoursValue("By phone enquiry")).toBeNull();
    expect(parseHoursValue("Closed")).toBeNull();
  });

  it("serializes in the house style (em-dash)", () => {
    expect(serializeHoursValue("10:00", "19:00")).toBe("10:00 – 19:00");
  });
});

describe("parsePriceList / serializePriceList", () => {
  it("parses entries split on the middle dot", () => {
    expect(parsePriceList("Full Face — £330 · Three Areas — £220")).toEqual([
      { label: "Full Face", amount: "£330" },
      { label: "Three Areas", amount: "£220" },
    ]);
  });

  it("parses the nbsp house style identically to plain spaces", () => {
    expect(parsePriceList("Full Face — £330 · Three Areas — £220")).toEqual([
      { label: "Full Face", amount: "£330" },
      { label: "Three Areas", amount: "£220" },
    ]);
  });

  it("parses a single entry", () => {
    expect(parsePriceList("Lips — from £60")).toEqual([{ label: "Lips", amount: "from £60" }]);
  });

  it("returns null for unparseable text (→ free-text mode)", () => {
    expect(parsePriceList("Complimentary")).toBeNull();
    expect(parsePriceList("")).toBeNull();
  });

  it("serializes with the nbsp·nbsp house separator", () => {
    const out = serializePriceList([
      { label: "Full Face", amount: "£330" },
      { label: "Three Areas", amount: "£220" },
    ]);
    expect(out).toBe("Full Face — £330 · Three Areas — £220");
  });

  it("round-trips", () => {
    const source = "Full Face — £330 · Three Areas — £220";
    const parsed = parsePriceList(source);
    expect(parsed).not.toBeNull();
    expect(serializePriceList(parsed ?? [])).toBe(source);
  });

  it("drops fully-blank rows on serialize", () => {
    expect(serializePriceList([{ label: "", amount: "" }, { label: "Lips", amount: "£60" }])).toBe(
      "Lips — £60",
    );
  });
});

describe("buildHoursControl", () => {
  it("renders one row per day and commits the whole array", () => {
    const onCommit = vi.fn();
    const sheet = buildHoursControl(
      [
        { day: "Monday", value: "10:00 – 19:00", closed: false },
        { day: "Wednesday", value: "By phone enquiry", closed: true },
      ],
      { onCommit, onCancel: vi.fn() },
    );
    document.body.appendChild(sheet);

    const rows = sheet.querySelectorAll(".wx-control-row");
    expect(rows).toHaveLength(2);
    // free-text row shows the text input, not the time inputs
    const secondRowText = rows[1]?.querySelector(".wx-control-text") as HTMLInputElement;
    expect(secondRowText.hidden).toBe(false);
    expect(secondRowText.value).toBe("By phone enquiry");

    (sheet.querySelector(".wx-control-commit") as HTMLButtonElement).click();
    expect(onCommit).toHaveBeenCalledWith([
      { day: "Monday", value: "10:00 – 19:00", closed: false },
      { day: "Wednesday", value: "By phone enquiry", closed: true },
    ]);
  });

  it("a row's custom-text toggle swaps between times and free text", () => {
    const sheet = buildHoursControl(
      [{ day: "Monday", value: "10:00 – 19:00", closed: false }],
      { onCommit: vi.fn(), onCancel: vi.fn() },
    );
    document.body.appendChild(sheet);
    const custom = sheet.querySelector(".wx-control-custom") as HTMLInputElement;
    const text = sheet.querySelector(".wx-control-text") as HTMLInputElement;
    const from = sheet.querySelector(".wx-control-time") as HTMLInputElement;
    expect(text.hidden).toBe(true);
    custom.checked = true;
    custom.dispatchEvent(new Event("change"));
    expect(text.hidden).toBe(false);
    expect(from.hidden).toBe(true);
  });
});

describe("buildQaControl (decisions/00090)", () => {
  it("renders one card per pair, full-screen, and commits the whole array", () => {
    const onCommit = vi.fn();
    const sheet = buildQaControl(
      [
        { question: "Do I need a consultation?", answer: "Yes — always free." },
        { question: "How do I book?", answer: "Use the [Book Now](#) button." },
      ],
      { onCommit, onCancel: vi.fn() },
    );
    document.body.appendChild(sheet);

    expect(sheet.classList.contains("wx-control-fullscreen")).toBe(true);
    const rows = sheet.querySelectorAll(".wx-qa-row");
    expect(rows).toHaveLength(2);
    expect((rows[1]?.querySelector(".wx-qa-question") as HTMLInputElement).value).toBe(
      "How do I book?",
    );
    expect((rows[1]?.querySelector(".wx-qa-answer") as HTMLTextAreaElement).value).toBe(
      "Use the [Book Now](#) button.",
    );

    (sheet.querySelector(".wx-control-commit") as HTMLButtonElement).click();
    expect(onCommit).toHaveBeenCalledWith([
      { question: "Do I need a consultation?", answer: "Yes — always free." },
      { question: "How do I book?", answer: "Use the [Book Now](#) button." },
    ]);
  });

  it("add-row appends a blank card and its filled values commit in order", () => {
    const onCommit = vi.fn();
    const sheet = buildQaControl([{ question: "Q one", answer: "A one" }], {
      onCommit,
      onCancel: vi.fn(),
    });
    document.body.appendChild(sheet);

    (sheet.querySelector(".wx-qa-add") as HTMLButtonElement).click();
    const rows = sheet.querySelectorAll(".wx-qa-row");
    expect(rows).toHaveLength(2);
    (rows[1]?.querySelector(".wx-qa-question") as HTMLInputElement).value = "Q two";
    (rows[1]?.querySelector(".wx-qa-answer") as HTMLTextAreaElement).value = "A two";

    (sheet.querySelector(".wx-control-commit") as HTMLButtonElement).click();
    expect(onCommit).toHaveBeenCalledWith([
      { question: "Q one", answer: "A one" },
      { question: "Q two", answer: "A two" },
    ]);
  });

  it("remove-row drops that pair from the committed array (middle removal)", () => {
    const onCommit = vi.fn();
    const sheet = buildQaControl(
      [
        { question: "Q one", answer: "A one" },
        { question: "Q two", answer: "A two" },
        { question: "Q three", answer: "A three" },
      ],
      { onCommit, onCancel: vi.fn() },
    );
    document.body.appendChild(sheet);

    const rows = sheet.querySelectorAll(".wx-qa-row");
    (rows[1]?.querySelector(".wx-qa-remove") as HTMLButtonElement).click();
    expect(sheet.querySelectorAll(".wx-qa-row")).toHaveLength(2);

    (sheet.querySelector(".wx-control-commit") as HTMLButtonElement).click();
    expect(onCommit).toHaveBeenCalledWith([
      { question: "Q one", answer: "A one" },
      { question: "Q three", answer: "A three" },
    ]);
  });

  it("renumbers the visible Q labels after a removal", () => {
    const sheet = buildQaControl(
      [
        { question: "Q one", answer: "A one" },
        { question: "Q two", answer: "A two" },
      ],
      { onCommit: vi.fn(), onCancel: vi.fn() },
    );
    document.body.appendChild(sheet);
    (sheet.querySelectorAll(".wx-qa-row")[0]?.querySelector(".wx-qa-remove") as HTMLButtonElement).click();
    const labels = Array.from(sheet.querySelectorAll(".wx-qa-number")).map((n) => n.textContent);
    expect(labels).toEqual(["Q1"]);
  });

  it("drops pairs left blank in BOTH fields on commit (no empty FAQ entries)", () => {
    const onCommit = vi.fn();
    const sheet = buildQaControl([{ question: "Q one", answer: "A one" }], {
      onCommit,
      onCancel: vi.fn(),
    });
    document.body.appendChild(sheet);
    (sheet.querySelector(".wx-qa-add") as HTMLButtonElement).click(); // blank row, never filled

    (sheet.querySelector(".wx-control-commit") as HTMLButtonElement).click();
    expect(onCommit).toHaveBeenCalledWith([{ question: "Q one", answer: "A one" }]);
  });

  it("cancel fires onCancel without committing", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const sheet = buildQaControl([{ question: "Q", answer: "A" }], { onCommit, onCancel });
    document.body.appendChild(sheet);
    (sheet.querySelector(".wx-composer-cancel") as HTMLButtonElement).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("buildPriceControl", () => {
  it("renders one row per parsed entry and commits serialized text", () => {
    const onCommit = vi.fn();
    const sheet = buildPriceControl("Full Face — £330 · Three Areas — £220", {
      onCommit,
      onCancel: vi.fn(),
    });
    document.body.appendChild(sheet);

    expect(sheet.querySelectorAll(".wx-price-rows .wx-control-row")).toHaveLength(2);
    (sheet.querySelector(".wx-control-commit") as HTMLButtonElement).click();
    expect(onCommit).toHaveBeenCalledWith("Full Face — £330 · Three Areas — £220");
  });

  it("starts in free-text mode for unparseable text", () => {
    const sheet = buildPriceControl("Complimentary", { onCommit: vi.fn(), onCancel: vi.fn() });
    document.body.appendChild(sheet);
    const textArea = sheet.querySelector(".wx-price-freetext") as HTMLTextAreaElement;
    expect(textArea.hidden).toBe(false);
    expect(textArea.value).toBe("Complimentary");
  });

  it("add-row and remove-row update the committed output", () => {
    const onCommit = vi.fn();
    const sheet = buildPriceControl("Lips — £60", { onCommit, onCancel: vi.fn() });
    document.body.appendChild(sheet);

    (sheet.querySelector(".wx-price-add") as HTMLButtonElement).click();
    const rows = sheet.querySelectorAll(".wx-price-rows .wx-control-row");
    expect(rows).toHaveLength(2);
    const newRow = rows[1] as HTMLElement;
    (newRow.querySelector(".wx-price-label") as HTMLInputElement).value = "Chin";
    (newRow.querySelector(".wx-price-amount") as HTMLInputElement).value = "£80";

    (sheet.querySelector(".wx-control-commit") as HTMLButtonElement).click();
    expect(onCommit).toHaveBeenCalledWith("Lips — £60 · Chin — £80");
  });
});
