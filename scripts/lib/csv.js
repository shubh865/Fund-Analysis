function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      value = '';
    } else value += character;
  }
  row.push(value);
  if (row.some((cell) => cell !== '')) rows.push(row);
  const [headers = [], ...records] = rows;
  return records.map((record) => Object.fromEntries(headers.map((header, index) => [header.trim(), (record[index] || '').trim()])));
}

module.exports = { parseCsv };
