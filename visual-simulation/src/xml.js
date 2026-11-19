/**
 * Minimal XML reader for OpenRocket .ork documents.
 *
 * OpenRocket's design files are plain XML without namespaces, so a compact
 * non-validating parser is enough.  It is shared by the browser app and the
 * Node validation harness, which keeps both paths identical.
 *
 * Element shape: { name, attrs, children, text, parent }
 */

const ENTITIES = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
};

function decodeEntities(s) {
	if (s.indexOf('&') < 0) {
		return s;
	}
	return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
		if (body[0] === '#') {
			const hex = body[1] === 'x' || body[1] === 'X';
			const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : m;
		}
		const v = ENTITIES[body];
		return v === undefined ? m : v;
	});
}

const NAME_RE = /^[^\s/>]+/;
const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttributes(s) {
	const attrs = Object.create(null);
	if (!s) {
		return attrs;
	}
	ATTR_RE.lastIndex = 0;
	let m;
	while ((m = ATTR_RE.exec(s)) !== null) {
		attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
	}
	return attrs;
}

export function parseXML(source) {
	const root = { name: '#document', attrs: Object.create(null), children: [], text: '', parent: null };
	let node = root;
	let i = 0;
	const len = source.length;

	while (i < len) {
		const lt = source.indexOf('<', i);
		if (lt < 0) {
			node.text += decodeEntities(source.slice(i));
			break;
		}
		if (lt > i) {
			node.text += decodeEntities(source.slice(i, lt));
		}

		if (source.startsWith('<!--', lt)) {
			const end = source.indexOf('-->', lt + 4);
			i = end < 0 ? len : end + 3;
			continue;
		}
		if (source.startsWith('<![CDATA[', lt)) {
			const end = source.indexOf(']]>', lt + 9);
			node.text += source.slice(lt + 9, end < 0 ? len : end);
			i = end < 0 ? len : end + 3;
			continue;
		}
		if (source.startsWith('<?', lt)) {
			const end = source.indexOf('?>', lt + 2);
			i = end < 0 ? len : end + 2;
			continue;
		}
		if (source.startsWith('<!', lt)) {
			// DOCTYPE and friends; skip any internal subset.
			let depth = 0;
			let j = lt + 2;
			for (; j < len; j++) {
				const c = source[j];
				if (c === '[') depth++;
				else if (c === ']') depth--;
				else if (c === '>' && depth <= 0) break;
			}
			i = j + 1;
			continue;
		}

		const gt = source.indexOf('>', lt + 1);
		if (gt < 0) {
			break;
		}
		let inner = source.slice(lt + 1, gt);

		if (inner[0] === '/') {
			const closed = inner.slice(1).trim();
			// Tolerate stray closers by unwinding to the matching ancestor.
			let target = node;
			while (target && target.name !== closed) {
				target = target.parent;
			}
			if (target && target.parent) {
				node = target.parent;
			}
			i = gt + 1;
			continue;
		}

		const selfClosing = inner.endsWith('/');
		if (selfClosing) {
			inner = inner.slice(0, -1);
		}
		const nameMatch = NAME_RE.exec(inner);
		const name = nameMatch ? nameMatch[0] : '';
		const attrText = nameMatch ? inner.slice(nameMatch[0].length) : '';

		const el = {
			name,
			attrs: parseAttributes(attrText),
			children: [],
			text: '',
			parent: node,
		};
		node.children.push(el);

		if (!selfClosing) {
			node = el;
		}
		i = gt + 1;
	}

	return root;
}

/** First direct child with the given tag name. */
export function child(el, name) {
	if (!el) return null;
	for (const c of el.children) {
		if (c.name === name) return c;
	}
	return null;
}

/** All direct children with the given tag name. */
export function children(el, name) {
	if (!el) return [];
	return el.children.filter((c) => c.name === name);
}

/** Trimmed text of the first direct child with the given tag name. */
export function childText(el, name, fallback) {
	const c = child(el, name);
	if (!c) return fallback;
	const t = c.text.trim();
	return t === '' ? fallback : t;
}

/** First direct child whose `name` is one of `names`. */
export function childAny(el, names) {
	if (!el) return null;
	for (const c of el.children) {
		if (names.indexOf(c.name) >= 0) return c;
	}
	return null;
}
