import { describe, expect, it } from "vitest";
import { extractQrImage, pickString } from "./qr.server";

describe("pickString — travessia por paths", () => {
  it("retorna primeiro path válido", () => {
    const src = { a: { b: "hello" }, c: "world" };
    expect(pickString(src, [["x"], ["a", "b"], ["c"]])).toBe("hello");
  });
  it("ignora strings vazias", () => {
    expect(pickString({ a: "   ", b: "ok" }, [["a"], ["b"]])).toBe("ok");
  });
  it("null-safe em paths inexistentes", () => {
    expect(pickString(null, [["a", "b"]])).toBeNull();
    expect(pickString({}, [["x", "y", "z"]])).toBeNull();
  });
});

describe("extractQrImage — normaliza formatos heterogêneos", () => {
  it("retorna data URL diretamente quando já vem formatada", async () => {
    const url = "data:image/png;base64,AAAA";
    expect(await extractQrImage({ base64: url })).toBe(url);
  });

  it("wrapa SVG cru em data URL base64", async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
    const result = await extractQrImage({ image: svg });
    expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("gera SVG a partir de string de código (fallback)", async () => {
    const result = await extractQrImage({ code: "2@abcd,xyz==" });
    expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("aceita PNG base64 puro (iVBORw prefix)", async () => {
    const png = "iVBORw0KGgo" + "A".repeat(900);
    const result = await extractQrImage({ qr: png });
    expect(result).toBe(`data:image/png;base64,${png}`);
  });

  it("retorna null quando não há QR nenhum", async () => {
    expect(await extractQrImage({ foo: "bar" })).toBeNull();
    expect(await extractQrImage(null)).toBeNull();
  });

  it("prefere imagem já pronta ao invés de re-gerar do code", async () => {
    const url = "data:image/png;base64,AAAA";
    const result = await extractQrImage({ base64: url, code: "should-be-ignored" });
    expect(result).toBe(url);
  });

  it("varre payloads aninhados (data.qrcode.base64)", async () => {
    const url = "data:image/png;base64,ZZZ";
    expect(await extractQrImage({ data: { qrcode: { base64: url } } })).toBe(url);
  });
});
