import { pdfBuffer, pdfPageSize } from './report-files';

// The page box as PDFKit writes it: [0 0 width height] in points
const mediaBox = (pdf: Buffer) =>
  /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/
    .exec(pdf.toString('latin1'))
    ?.slice(1)
    .map(Number);

describe('report PDF paper', () => {
  it('is US Letter unless the store chose A4', () => {
    expect(pdfPageSize(undefined)).toBe('LETTER');
    expect(pdfPageSize('letter')).toBe('LETTER');
    expect(pdfPageSize('a4')).toBe('A4');
  });

  it('builds Letter pages by default and A4 pages on request', async () => {
    const build = (doc: PDFKit.PDFDocument) => doc.text('Daily summary');
    expect(mediaBox(await pdfBuffer(build, 'Test'))).toEqual([612, 792]);
    expect(mediaBox(await pdfBuffer(build, 'Test', 'letter'))).toEqual([
      612, 792,
    ]);
    expect(mediaBox(await pdfBuffer(build, 'Test', 'a4'))).toEqual([
      595.28, 841.89,
    ]);
  });
});
