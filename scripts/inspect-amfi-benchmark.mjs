import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const input = await FileBlob.load(process.argv[2]);
const workbook = await SpreadsheetFile.importXlsx(input);
const inspection = await workbook.inspect({
  kind: 'workbook,sheet,table',
  maxChars: 12000,
  tableMaxRows: 80,
  tableMaxCols: 12,
  tableMaxCellChars: 160
});
console.log(inspection.ndjson);
