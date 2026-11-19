/**
 * Reader for .ork container archives.
 *
 * Since OpenRocket 15.03 a design is a ZIP archive containing `rocket.ork`
 * (the actual XML document) plus any decal images.  Older files, and files
 * produced by other tools, may also be plain XML, so both are accepted.
 *
 * `inflateRaw` is injected so the same code runs in the browser
 * (DecompressionStream) and in Node (zlib).
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function readU16(bytes, off) {
	return bytes[off] | (bytes[off + 1] << 8);
}

function readU32(bytes, off) {
	return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function findEndOfCentralDirectory(bytes) {
	const min = Math.max(0, bytes.length - 0xffff - 22);
	for (let i = bytes.length - 22; i >= min; i--) {
		if (readU32(bytes, i) === END_OF_CENTRAL_DIRECTORY) {
			return i;
		}
	}
	return -1;
}

export function isZip(bytes) {
	return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function defaultInflateRaw(data) {
	if (typeof DecompressionStream === 'function') {
		const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
		const buffer = await new Response(stream).arrayBuffer();
		return new Uint8Array(buffer);
	}
	throw new Error('No deflate-raw implementation available');
}

/**
 * List the entries of a ZIP archive.
 * @returns {Promise<Array<{name: string, bytes: Uint8Array}>>}
 */
export async function readZipEntries(bytes, inflateRaw = defaultInflateRaw) {
	const eocd = findEndOfCentralDirectory(bytes);
	if (eocd < 0) {
		throw new Error('Not a ZIP archive (no end-of-central-directory record)');
	}

	const entryCount = readU16(bytes, eocd + 10);
	const cdOffset = readU32(bytes, eocd + 16);
	const decoder = new TextDecoder('utf-8');
	const entries = [];

	let ptr = cdOffset;
	for (let i = 0; i < entryCount; i++) {
		if (readU32(bytes, ptr) !== CENTRAL_HEADER) {
			break;
		}
		const method = readU16(bytes, ptr + 10);
		const compressedSize = readU32(bytes, ptr + 20);
		const uncompressedSize = readU32(bytes, ptr + 24);
		const nameLen = readU16(bytes, ptr + 28);
		const extraLen = readU16(bytes, ptr + 30);
		const commentLen = readU16(bytes, ptr + 32);
		const localOffset = readU32(bytes, ptr + 42);
		const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));

		// Sizes may live in the local header when the central copy is empty
		// (streamed archives), so cross-check.
		let dataStart = localOffset;
		if (readU32(bytes, localOffset) === LOCAL_HEADER) {
			dataStart = localOffset + 30 + readU16(bytes, localOffset + 26) + readU16(bytes, localOffset + 28);
		}

		let size = compressedSize;
		if (size === 0 && uncompressedSize > 0) {
			size = bytes.length - dataStart;
		}

		const raw = bytes.subarray(dataStart, dataStart + size);
		entries.push({ name, method, raw, compressedSize: size, uncompressedSize });

		ptr += 46 + nameLen + extraLen + commentLen;
	}

	const out = [];
	for (const e of entries) {
		if (e.name.endsWith('/')) {
			continue;
		}
		let data;
		if (e.method === 0) {
			data = e.raw;
		} else if (e.method === 8) {
			data = await inflateRaw(e.raw);
		} else {
			continue; // unsupported compression
		}
		out.push({ name: e.name, bytes: data });
	}
	return out;
}

/**
 * Extract the design document from an uploaded .ork file.
 * @returns {Promise<{xml: string, files: Map<string, Uint8Array>}>}
 */
export async function readOrkFile(arrayBuffer, inflateRaw = defaultInflateRaw) {
	const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
	const decoder = new TextDecoder('utf-8');

	if (!isZip(bytes)) {
		return { xml: decoder.decode(bytes), files: new Map() };
	}

	const entries = await readZipEntries(bytes, inflateRaw);
	const files = new Map(entries.map((e) => [e.name, e.bytes]));
	const design = entries.find((e) => /(^|\/)rocket\.ork$/i.test(e.name)) ||
		entries.find((e) => /\.ork$/i.test(e.name));
	if (!design) {
		throw new Error('Archive does not contain a rocket.ork design document');
	}
	return { xml: decoder.decode(design.bytes), files };
}
