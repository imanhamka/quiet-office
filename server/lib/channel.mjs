const OPEN = '<channel';
const SCAN_MAX = 4096;
const ATTR_NAME = /[A-Za-z_][\w.:-]*/y;
const SPACE = /\s/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(v) {
  return v.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);
}

// Attributes of the `<channel ...>` tag that opens an inbound channel message.
// Reads only up to the tag's closing `>`: the message body is never looked at.
// Returns null when the content does not start with a well-formed tag.
export function channelTagAttrs(content) {
  if (typeof content !== 'string') return null;
  let i = 0;
  while (i < content.length && SPACE.test(content[i])) i++;
  if (!content.startsWith(OPEN, i)) return null;
  i += OPEN.length;
  const end = Math.min(content.length, i + SCAN_MAX);
  if (i >= end || !(SPACE.test(content[i]) || content[i] === '>')) return null;
  const attrs = new Map();
  for (;;) {
    while (i < end && SPACE.test(content[i])) i++;
    if (i >= end) return null;
    if (content[i] === '>') return attrs;
    ATTR_NAME.lastIndex = i;
    const m = ATTR_NAME.exec(content);
    if (!m) return null;
    const name = m[0];
    i += name.length;
    while (i < end && SPACE.test(content[i])) i++;
    if (content[i] !== '=') {
      if (!attrs.has(name)) attrs.set(name, '');
      continue;
    }
    i++;
    while (i < end && SPACE.test(content[i])) i++;
    const q = content[i];
    if (q !== '"' && q !== "'") return null;
    const close = content.indexOf(q, i + 1);
    if (close === -1 || close >= end) return null;
    if (!attrs.has(name)) attrs.set(name, decode(content.slice(i + 1, close)));
    i = close + 1;
  }
}

// `channels` holds plugin server names. An entry matches the full source ("plugin:chat:chat")
// or its last segment ("chat"), case-insensitive. An empty list matches any source.
export function channelAllowed(source, channels) {
  if (!channels || channels.length === 0) return true;
  if (typeof source !== 'string' || !source) return false;
  const s = source.toLowerCase();
  return channels.some((c) => {
    const want = c.toLowerCase();
    return s === want || s.endsWith(`:${want}`);
  });
}
