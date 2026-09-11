import { describe, expect, it } from "vitest";
import { createTranslator, localeChain, SUPPORTED_LOCALES } from "../src/index.js";

describe("localeChain", () => {
  it("maps pt-BR to pt-BR then en", () => {
    expect(localeChain("pt-BR")).toEqual(["pt-BR", "en"]);
  });

  it("maps en to just en", () => {
    expect(localeChain("en")).toEqual(["en"]);
  });
});

describe("createTranslator", () => {
  it("resolves an English key", async () => {
    const t = await createTranslator("en");
    expect(t("connections.add")).toBe("Add connection");
  });

  it("resolves a pt-BR key", async () => {
    const t = await createTranslator("pt-BR");
    expect(t("connections.add")).toBe("Adicionar conexão");
  });

  it("declares the supported locales", () => {
    expect(SUPPORTED_LOCALES).toContain("en");
    expect(SUPPORTED_LOCALES).toContain("pt-BR");
  });
});
