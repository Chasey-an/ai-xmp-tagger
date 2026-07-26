// @vitest-environment node

import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";

import { MAX_XMP_BYTES, TARGET_SUBJECT } from "../../src/core/constants";
import { ProcessingError } from "../../src/core/errors";
import {
  createNormalizedPacket,
  inspectPacket,
} from "../../src/core/xmp/model";

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const XMP_META_NS = "adobe:ns:meta/";
const textEncoder = new TextEncoder();

function packet(properties = "", descriptionAttributes = "") {
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    `<x:xmpmeta xmlns:x="${XMP_META_NS}">`,
    `<rdf:RDF xmlns:rdf="${RDF_NS}">`,
    `<rdf:Description rdf:about="" xmlns:dc="${DC_NS}" ${descriptionAttributes}>`,
    properties,
    "</rdf:Description>",
    "</rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("");
}

function subject(items: string[], prefix = "rdf") {
  return `<dc:subject><${prefix}:Bag>${items
    .map((item) => `<${prefix}:li>${item}</${prefix}:li>`)
    .join("")}</${prefix}:Bag></dc:subject>`;
}

function byteLength(value: string) {
  return textEncoder.encode(value).byteLength;
}

function packetWithPadding(padding: string, includeSubject = false) {
  return packet(
    [
      includeSubject ? subject([TARGET_SUBJECT]) : "",
      `<custom:data xmlns:custom="urn:custom">x${padding}</custom:data>`,
    ].join(""),
  );
}

function packetAtInputByteLength(targetBytes: number, includeSubject = false) {
  const base = packetWithPadding("", includeSubject);
  const paddingBytes = targetBytes - byteLength(base);

  expect(paddingBytes).toBeGreaterThanOrEqual(0);
  const padded = packetWithPadding("a".repeat(paddingBytes), includeSubject);
  expect(byteLength(padded)).toBe(targetBytes);
  return padded;
}

function packetForNormalizedByteLength(targetBytes: number) {
  const base = packetWithPadding("");
  const normalizedBase = createNormalizedPacket(base);
  const paddingBytes = targetBytes - byteLength(normalizedBase);

  expect(paddingBytes).toBeGreaterThanOrEqual(0);
  return packetWithPadding("a".repeat(paddingBytes));
}

function expectProcessingError(
  operation: () => unknown,
  code: "INVALID_XMP" | "XMP_CONFLICT",
) {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessingError);
    expect(error).toMatchObject({ name: "ProcessingError", code });
  }
}

describe("XMP RDF subject model", () => {
  it("reports an absent packet without a subject", () => {
    expect(inspectPacket(null)).toEqual({
      subjectExists: false,
      subjects: [],
      targetTagCount: 0,
    });
  });

  it("creates an explicit XMP packet containing exactly one target subject", () => {
    const normalized = createNormalizedPacket(null);

    expect(normalized).toContain("<?xpacket ");
    expect(normalized).toContain("<x:xmpmeta");
    expect(normalized).toContain("<rdf:RDF");
    expect(normalized).toContain("<rdf:Description");
    expect(normalized).toContain("<dc:subject");
    expect(normalized).toContain("<rdf:Bag");
    expect(normalized).toContain(`<rdf:li>${TARGET_SUBJECT}</rdf:li>`);
    expect(normalized).toContain('<?xpacket end="w"?>');
    expect(inspectPacket(normalized)).toEqual({
      subjectExists: true,
      subjects: [TARGET_SUBJECT],
      targetTagCount: 1,
    });
  });

  it("preserves other keywords in order while replacing duplicate targets with one final target", () => {
    const xml = packet(
      subject(["portrait", TARGET_SUBJECT, "studio", TARGET_SUBJECT, "night"]),
    );

    const normalized = createNormalizedPacket(xml);

    expect(inspectPacket(normalized)).toEqual({
      subjectExists: true,
      subjects: ["portrait", "studio", "night", TARGET_SUBJECT],
      targetTagCount: 1,
    });
  });

  it("preserves unrelated elements, attributes, namespace declarations, and processing instructions", () => {
    const xml = packet(
      [
        '<?custom preserve="yes"?>',
        "<xmp:CreatorTool>Lightroom</xmp:CreatorTool>",
        "<xmp:Rating>4</xmp:Rating>",
        subject(["portrait"]),
      ].join(""),
      'xmlns:xmp="http://ns.adobe.com/xap/1.0/" custom:flag="kept" xmlns:custom="urn:custom"',
    );

    const normalized = createNormalizedPacket(xml);
    const document = new DOMParser().parseFromString(normalized, "application/xml");
    const description = document.getElementsByTagNameNS(RDF_NS, "Description")[0];

    expect(normalized).toContain('<?custom preserve="yes"?>');
    expect(normalized).toContain('xmlns:custom="urn:custom"');
    expect(description?.getAttributeNS("urn:custom", "flag")).toBe("kept");
    expect(
      document.getElementsByTagNameNS(
        "http://ns.adobe.com/xap/1.0/",
        "CreatorTool",
      )[0]?.textContent,
    ).toBe("Lightroom");
    expect(
      document.getElementsByTagNameNS(
        "http://ns.adobe.com/xap/1.0/",
        "Rating",
      )[0]?.textContent,
    ).toBe("4");
  });

  it("normalizes a packet with an XML declaration while preserving xpacket processing instructions", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>${packet(
      subject(["portrait"]),
    )}`;

    expect(inspectPacket(xml)).toEqual({
      subjectExists: true,
      subjects: ["portrait"],
      targetTagCount: 0,
    });

    const normalized = createNormalizedPacket(xml);
    expect(normalized).not.toContain("<?xml ");
    expect(normalized).toContain(
      '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    );
    expect(normalized).toContain('<?xpacket end="w"?>');
    expect(inspectPacket(normalized)).toEqual({
      subjectExists: true,
      subjects: ["portrait", TARGET_SUBJECT],
      targetTagCount: 1,
    });
  });

  it("adds a subject Bag to an existing packet that has no dc:subject", () => {
    const xml = packet(
      '<xmp:CreatorTool xmlns:xmp="http://ns.adobe.com/xap/1.0/">Capture One</xmp:CreatorTool>',
    );

    const normalized = createNormalizedPacket(xml);

    expect(normalized).toContain("Capture One");
    expect(inspectPacket(normalized)).toEqual({
      subjectExists: true,
      subjects: [TARGET_SUBJECT],
      targetTagCount: 1,
    });
  });

  it("uses namespace URIs rather than fixed RDF and DC prefixes", () => {
    const xml = [
      `<meta xmlns="${XMP_META_NS}">`,
      `<r:root xmlns:r="${RDF_NS}" xmlns:d="${DC_NS}">`,
      '<r:Description r:about="">',
      "<d:subject><r:Bag><r:li>existing</r:li></r:Bag></d:subject>",
      "</r:Description>",
      "</r:root>",
      "</meta>",
    ].join("");

    const normalized = createNormalizedPacket(xml);

    expect(inspectPacket(normalized)).toEqual({
      subjectExists: true,
      subjects: ["existing", TARGET_SUBJECT],
      targetTagCount: 1,
    });
    expect(normalized).toContain("<r:li>existing</r:li>");
  });

  it("permits and decodes the five predefined XML entities", () => {
    const xml = packet(
      subject(["A &amp; B", "&lt;tag&gt;", "&quot;quoted&quot;", "it&apos;s"]),
    );

    expect(inspectPacket(createNormalizedPacket(xml))).toEqual({
      subjectExists: true,
      subjects: ["A & B", "<tag>", '"quoted"', "it's", TARGET_SUBJECT],
      targetTagCount: 1,
    });
  });

  it.each([
    ["malformed XML", packet("<dc:subject>")],
    [
      "a DOCTYPE declaration",
      `<!DOCTYPE xmp [<!ENTITY custom "expanded">]>${packet(
        subject(["&custom;"]),
      )}`,
    ],
    ["an unresolved custom entity", packet(subject(["&unknown;"]))],
  ])("rejects %s as INVALID_XMP", (_label, xml) => {
    expectProcessingError(() => inspectPacket(xml), "INVALID_XMP");
    expectProcessingError(() => createNormalizedPacket(xml), "INVALID_XMP");
  });

  it("rejects multiple dc:subject properties as XMP_CONFLICT", () => {
    const xml = packet(subject(["one"]) + subject(["two"]));

    expectProcessingError(() => inspectPacket(xml), "XMP_CONFLICT");
    expectProcessingError(() => createNormalizedPacket(xml), "XMP_CONFLICT");
  });

  it.each([
    ["without an element property", ""],
    ["alongside an element property", subject(["existing"])],
  ])(
    "rejects an arbitrarily-prefixed dc:subject property attribute %s",
    (_label, properties) => {
      const xml = packet(
        properties,
        `xmlns:terms="${DC_NS}" terms:subject="literal keyword"`,
      );

      expectProcessingError(() => inspectPacket(xml), "XMP_CONFLICT");
      expectProcessingError(
        () => createNormalizedPacket(xml),
        "XMP_CONFLICT",
      );
    },
  );

  it("rejects a dc:subject whose container is not rdf:Bag as XMP_CONFLICT", () => {
    const xml = packet(
      `<dc:subject><rdf:Seq><rdf:li>one</rdf:li></rdf:Seq></dc:subject>`,
    );

    expectProcessingError(() => inspectPacket(xml), "XMP_CONFLICT");
    expectProcessingError(() => createNormalizedPacket(xml), "XMP_CONFLICT");
  });

  it("rejects a dc:subject without exactly one element container as XMP_CONFLICT", () => {
    const noContainer = packet("<dc:subject>plain text</dc:subject>");
    const twoContainers = packet(
      "<dc:subject><rdf:Bag/><rdf:Bag/></dc:subject>",
    );

    expectProcessingError(() => inspectPacket(noContainer), "XMP_CONFLICT");
    expectProcessingError(
      () => createNormalizedPacket(twoContainers),
      "XMP_CONFLICT",
    );
  });

  it("accepts valid UTF-8 input exactly MAX_XMP_BYTES long", () => {
    const exactLimit = packetAtInputByteLength(MAX_XMP_BYTES, true);

    expect(inspectPacket(exactLimit)).toEqual({
      subjectExists: true,
      subjects: [TARGET_SUBJECT],
      targetTagCount: 1,
    });
    expect(() => createNormalizedPacket(exactLimit)).not.toThrow();
  });

  it("rejects UTF-8 input larger than MAX_XMP_BYTES", () => {
    const oversized = `${packetAtInputByteLength(MAX_XMP_BYTES, true)}a`;

    expect(byteLength(oversized)).toBe(MAX_XMP_BYTES + 1);

    expectProcessingError(() => inspectPacket(oversized), "INVALID_XMP");
    expectProcessingError(
      () => createNormalizedPacket(oversized),
      "INVALID_XMP",
    );
  });

  it("accepts serialized UTF-8 output exactly MAX_XMP_BYTES long", () => {
    const exactOutputPacket = packetForNormalizedByteLength(MAX_XMP_BYTES);

    expect(byteLength(exactOutputPacket)).toBeLessThan(MAX_XMP_BYTES);
    const normalized = createNormalizedPacket(exactOutputPacket);
    expect(byteLength(normalized)).toBe(MAX_XMP_BYTES);
    expect(inspectPacket(normalized).targetTagCount).toBe(1);
  });

  it("rejects normalization when serialized UTF-8 output exceeds MAX_XMP_BYTES", () => {
    const overflowingOutputPacket = packetForNormalizedByteLength(
      MAX_XMP_BYTES + 1,
    );

    expect(byteLength(overflowingOutputPacket)).toBeLessThanOrEqual(
      MAX_XMP_BYTES,
    );
    expectProcessingError(
      () => createNormalizedPacket(overflowingOutputPacket),
      "INVALID_XMP",
    );
  });

  it("constructs ProcessingError with a stable name, code, and cause", () => {
    const cause = new Error("root cause");
    const error = new ProcessingError("INVALID_XMP", "bad packet", { cause });

    expect(error.name).toBe("ProcessingError");
    expect(error.code).toBe("INVALID_XMP");
    expect(error.message).toBe("bad packet");
    expect(error.cause).toBe(cause);
  });
});
