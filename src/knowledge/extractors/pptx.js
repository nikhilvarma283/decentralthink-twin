import officeParser from 'officeparser';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const parseOffice = promisify(officeParser.parseOffice);

export async function extractPptx(source) {
  if (!source.buffer) throw new Error('PPTX extraction requires a file buffer');

  // officeParser needs a file path — write to tmp
  const tmpPath = join(tmpdir(), `${uuidv4()}.pptx`);
  try {
    await writeFile(tmpPath, source.buffer);
    const text = await parseOffice(tmpPath);
    return {
      text: text.trim(),
      metadata: { filename: source.filename, format: 'pptx' },
      contentType: 'pptx',
    };
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
