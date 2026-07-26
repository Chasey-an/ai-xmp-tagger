import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type {
  Document as XmlDocument,
  Element as XmlElement,
} from "@xmldom/xmldom";

import {
  DC_NS,
  MAX_XMP_BYTES,
  RDF_NS,
  TARGET_SUBJECT,
  XMP_META_NS,
} from "../constants";
import { ProcessingError } from "../errors";
import type { SubjectCheck } from "../types";

const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const textEncoder = new TextEncoder();

interface ParsedPacket {
  document: XmlDocument;
  subject: XmlElement | null;
  bag: XmlElement | null;
}

function invalidXmp(message: string, cause?: unknown): ProcessingError {
  return cause === undefined
    ? new ProcessingError("INVALID_XMP", message)
    : new ProcessingError("INVALID_XMP", message, { cause });
}

function assertPacketSize(xml: string, stage: "input" | "output"): void {
  if (textEncoder.encode(xml).byteLength > MAX_XMP_BYTES) {
    throw invalidXmp(`XMP ${stage} exceeds ${MAX_XMP_BYTES} bytes`);
  }
}

function hasForbiddenDeclaration(xml: string): boolean {
  let position = 0;

  while (position < xml.length) {
    if (xml.startsWith("<!--", position)) {
      const end = xml.indexOf("-->", position + 4);
      position = end === -1 ? xml.length : end + 3;
      continue;
    }

    if (xml.startsWith("<![CDATA[", position)) {
      const end = xml.indexOf("]]>", position + 9);
      position = end === -1 ? xml.length : end + 3;
      continue;
    }

    if (xml.startsWith("<?", position)) {
      const end = xml.indexOf("?>", position + 2);
      position = end === -1 ? xml.length : end + 2;
      continue;
    }

    const remainder = xml.slice(position);
    if (/^<!\s*(?:DOCTYPE|ENTITY)\b/i.test(remainder)) {
      return true;
    }

    position += 1;
  }

  return false;
}

function elementsNamed(
  document: XmlDocument,
  namespace: string,
  localName: string,
): XmlElement[] {
  return Array.from(document.getElementsByTagNameNS(namespace, localName));
}

function elementChildren(element: XmlElement): XmlElement[] {
  const children: XmlElement[] = [];

  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (child !== null && child.nodeType === 1) {
      children.push(child as XmlElement);
    }
  }

  return children;
}

function parsePacket(xml: string): ParsedPacket {
  assertPacketSize(xml, "input");

  if (hasForbiddenDeclaration(xml)) {
    throw invalidXmp("XMP document type and entity declarations are not allowed");
  }

  const parseMessages: string[] = [];
  let document: XmlDocument;

  try {
    document = new DOMParser({
      onError(level, message) {
        parseMessages.push(`${level}: ${message}`);
      },
    }).parseFromString(xml, "application/xml");
  } catch (error) {
    throw invalidXmp("XMP is not well-formed XML", error);
  }

  if (parseMessages.length > 0 || document.documentElement === null) {
    const cause =
      parseMessages.length > 0 ? new Error(parseMessages.join("\n")) : undefined;
    throw invalidXmp("XMP is not well-formed XML", cause);
  }

  const descriptions = elementsNamed(document, RDF_NS, "Description");
  if (
    descriptions.some((description) =>
      description.hasAttributeNS(DC_NS, "subject"),
    )
  ) {
    throw new ProcessingError(
      "XMP_CONFLICT",
      "dc:subject must be an element property containing an rdf:Bag",
    );
  }

  const subjects = elementsNamed(document, DC_NS, "subject");
  if (subjects.length > 1) {
    throw new ProcessingError(
      "XMP_CONFLICT",
      "XMP contains more than one dc:subject property",
    );
  }

  const subject = subjects[0] ?? null;
  if (subject === null) {
    return { document, subject: null, bag: null };
  }

  const containers = elementChildren(subject);
  const bag = containers[0] ?? null;
  if (
    containers.length !== 1 ||
    bag === null ||
    bag.namespaceURI !== RDF_NS ||
    bag.localName !== "Bag"
  ) {
    throw new ProcessingError(
      "XMP_CONFLICT",
      "dc:subject must contain exactly one rdf:Bag",
    );
  }

  return { document, subject, bag };
}

function subjectItems(bag: XmlElement): XmlElement[] {
  return elementChildren(bag).filter(
    (element) =>
      element.namespaceURI === RDF_NS && element.localName === "li",
  );
}

function inspectParsedPacket(packet: ParsedPacket): SubjectCheck {
  if (packet.subject === null || packet.bag === null) {
    return {
      subjectExists: false,
      subjects: [],
      targetTagCount: 0,
    };
  }

  const subjects = subjectItems(packet.bag).map(
    (item) => item.textContent ?? "",
  );

  return {
    subjectExists: true,
    subjects,
    targetTagCount: subjects.filter((item) => item === TARGET_SUBJECT).length,
  };
}

function choosePrefix(
  context: XmlElement,
  namespace: string,
  preferred: string,
): string {
  const existing = context.lookupPrefix(namespace);
  if (existing !== null && existing !== "") {
    return existing;
  }

  let candidate = preferred;
  let suffix = 1;
  while (
    context.lookupNamespaceURI(candidate) !== null &&
    context.lookupNamespaceURI(candidate) !== namespace
  ) {
    candidate = `${preferred}${suffix}`;
    suffix += 1;
  }

  if (context.lookupNamespaceURI(candidate) !== namespace) {
    context.setAttributeNS(XMLNS_NS, `xmlns:${candidate}`, namespace);
  }

  return candidate;
}

function createSubjectBag(document: XmlDocument): {
  subject: XmlElement;
  bag: XmlElement;
} {
  const descriptions = elementsNamed(document, RDF_NS, "Description");
  const description = descriptions[0];
  if (description === undefined) {
    throw invalidXmp("XMP does not contain an rdf:Description");
  }

  const dcPrefix = choosePrefix(description, DC_NS, "dc");
  const rdfPrefix = choosePrefix(description, RDF_NS, "rdf");
  const subject = document.createElementNS(DC_NS, `${dcPrefix}:subject`);
  const bag = document.createElementNS(RDF_NS, `${rdfPrefix}:Bag`);
  subject.appendChild(bag);
  description.appendChild(subject);

  return { subject, bag };
}

function appendTarget(document: XmlDocument, bag: XmlElement): void {
  const targetItems = subjectItems(bag).filter(
    (item) => item.textContent === TARGET_SUBJECT,
  );
  for (const item of targetItems) {
    bag.removeChild(item);
  }

  const rdfPrefix =
    bag.prefix ??
    bag.lookupPrefix(RDF_NS) ??
    choosePrefix(bag, RDF_NS, "rdf");
  const qualifiedName = rdfPrefix === "" ? "li" : `${rdfPrefix}:li`;
  const target = document.createElementNS(RDF_NS, qualifiedName);
  target.appendChild(document.createTextNode(TARGET_SUBJECT));
  bag.appendChild(target);
}

function omitLeadingXmlDeclaration(document: XmlDocument): void {
  const firstNode = document.firstChild;
  if (
    firstNode !== null &&
    firstNode.nodeType === 7 &&
    firstNode.nodeName === "xml"
  ) {
    document.removeChild(firstNode);
  }
}

function emptyPacket(): string {
  return [
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    `<x:xmpmeta xmlns:x="${XMP_META_NS}">`,
    `<rdf:RDF xmlns:rdf="${RDF_NS}">`,
    `<rdf:Description rdf:about="" xmlns:dc="${DC_NS}"/>`,
    "</rdf:RDF>",
    "</x:xmpmeta>",
    '<?xpacket end="w"?>',
  ].join("");
}

export function inspectPacket(xml: string | null): SubjectCheck {
  if (xml === null) {
    return {
      subjectExists: false,
      subjects: [],
      targetTagCount: 0,
    };
  }

  return inspectParsedPacket(parsePacket(xml));
}

export function createNormalizedPacket(xml: string | null): string {
  const packet = parsePacket(xml ?? emptyPacket());
  const bag = packet.bag ?? createSubjectBag(packet.document).bag;

  appendTarget(packet.document, bag);
  omitLeadingXmlDeclaration(packet.document);

  let serialized: string;
  try {
    serialized = new XMLSerializer().serializeToString(packet.document, {
      requireWellFormed: true,
    });
  } catch (error) {
    throw invalidXmp("XMP could not be serialized as well-formed XML", error);
  }

  assertPacketSize(serialized, "output");
  return serialized;
}
