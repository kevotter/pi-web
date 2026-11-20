import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { createJiti } from "jiti";

const {
  PLANTUML_MAX_URL_LENGTH,
  PLANTUML_SVG_SERVER,
  encodePlantUml,
  encodePlantUmlBase64,
  encodePlantUmlHex,
  isPlantUmlLang,
  plantUmlSvgUrl,
} = await createJiti(import.meta.url).import("./plantuml.ts");

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

/** PlantUML's decoder, as its server reads the text back. */
function decode(encoded) {
  const bytes = [];
  for (let i = 0; i < encoded.length; i += 4) {
    const [c1, c2, c3, c4] = [...encoded.slice(i, i + 4)].map((c) => ALPHABET.indexOf(c));
    bytes.push((c1 << 2) | (c2 >> 4), ((c2 & 0xf) << 4) | (c3 >> 2), ((c3 & 0x3) << 6) | c4);
  }
  // The zero-filled tail of a short last group is past the deflate stream's end.
  return inflateRawSync(Buffer.from(bytes)).toString("utf8");
}

async function withCompressionStream(value, fn) {
  const original = globalThis.CompressionStream;
  if (value === undefined) delete globalThis.CompressionStream;
  else globalThis.CompressionStream = value;
  try {
    return await fn();
  } finally {
    globalThis.CompressionStream = original;
  }
}

test("the base64 matches plantuml.com's own example and plantuml-encoder", () => {
  // Fixed compressed bytes from plantuml.com's example and plantuml-encoder 1.4.0.
  // Different deflate implementations may produce different valid streams for the same text.
  const examples = [
    ["73ca4f52d0b55370ccc94c4e55b052c848cdc9c90700", "SyfFKj2rKt3CoKnELR1Io4ZDoSa70000"],
    ["73282e492c2a29cdcde172ccc94c4e55d0b55370ca4fb252f048cdc9c957e472ca4f52d0d5b553004b5a2978642a7239a4e6a594e6e60000",
      "SoWkIImgAStDuNBCoKnELT2rKt3AJx9Iy4ZDoSbNv7BAJrBGrRLJ04jQANXaAd8vfEQbbERc0000"],
    ["012e00d1ff407374617274756d6c0ae794a8e688b7202d3e20e7b3bbe7bb9f3a20e799bbe5bd9520e29c930a40656e64756d6c",
      "0Iu0qVz0StHXSdHrRMmAvvIeveYt82q-8EUpk-UxdpeWvvcxvRsL8EASamf0PMvaTMri"],
  ];
  for (const [bytes, encoded] of examples) {
    assert.equal(encodePlantUmlBase64(Buffer.from(bytes, "hex")), encoded);
  }
});

test("the base64 zero-fills a short last group to four characters", () => {
  assert.equal(encodePlantUmlBase64(new Uint8Array([])), "");
  assert.equal(encodePlantUmlBase64(new Uint8Array([0xff])), "_m00");
  assert.equal(encodePlantUmlBase64(new Uint8Array([0xff, 0xff])), "__y0");
  assert.equal(encodePlantUmlBase64(new Uint8Array([0xff, 0xff, 0xff])), "____");
});

test("the hex form is ~h and the UTF-8 bytes", () => {
  const bytes = new TextEncoder().encode("A -> 乙\n");
  assert.equal(encodePlantUmlHex(bytes), "~h41202d3e20e4b9990a");
});

test("encodePlantUml deflates where the browser has deflate-raw", async () => {
  const text = "@startuml\n用户 -> 系统: 登录 ✓\n@enduml";
  const encoded = await encodePlantUml(text);
  assert.match(encoded, /^[0-9A-Za-z_-]+$/);
  assert.equal(decode(encoded), text);
});

test("encodePlantUml falls back to hex without CompressionStream (Safari before 16.4)", async () => {
  const encoded = await withCompressionStream(undefined, () => encodePlantUml("A -> 乙\n"));
  assert.equal(encoded, "~h41202d3e20e4b9990a");
});

test("encodePlantUml falls back to hex where deflate-raw is refused (Chrome before 103)", async () => {
  const Original = globalThis.CompressionStream;
  class OldCompressionStream extends Original {
    constructor(format) {
      if (format === "deflate-raw") throw new TypeError(`Unsupported compression format: '${format}'`);
      super(format);
    }
  }
  const encoded = await withCompressionStream(OldCompressionStream, () => encodePlantUml("A -> 乙\n"));
  assert.equal(encoded, "~h41202d3e20e4b9990a");
});

test("plantUmlSvgUrl points at the SVG endpoint and sends nothing too long", async () => {
  assert.equal(PLANTUML_SVG_SERVER, "https://www.plantuml.com/plantuml/svg/");
  const url = await plantUmlSvgUrl("Bob -> Alice : hello");
  assert.ok(url.startsWith(PLANTUML_SVG_SERVER));
  assert.equal(decode(url.slice(PLANTUML_SVG_SERVER.length)), "Bob -> Alice : hello");

  const fits = "a".repeat((PLANTUML_MAX_URL_LENGTH - PLANTUML_SVG_SERVER.length - 2) / 2);
  await withCompressionStream(undefined, async () => {
    assert.equal((await plantUmlSvgUrl(fits)).length, PLANTUML_MAX_URL_LENGTH);
    assert.equal(await plantUmlSvgUrl(`${fits}a`), null);
  });
});

test("isPlantUmlLang takes plantuml and puml fences only", () => {
  assert.equal(isPlantUmlLang("plantuml"), true);
  assert.equal(isPlantUmlLang("puml"), true);
  for (const lang of ["", "uml", "mermaid", "svg", "plantuml2", "text"]) {
    assert.equal(isPlantUmlLang(lang), false, lang);
  }
});
