// Photo answers remain one survey answer. Multiple images are a JSON array
// serialized into esm_user_answer, which also works with AWARE's string field.
export function imageAnswers(answer) {
  if (typeof answer === 'string' && answer.trim().startsWith('[')) {
    try { answer = JSON.parse(answer); } catch { return []; }
  }
  return (Array.isArray(answer) ? answer : [answer]).map(decodeImage).filter(Boolean);
}

export function decodeImage(answer) {
  if (typeof answer !== 'string' || !answer.trim()) return null;
  const base64 = answer.trim().replace(/^data:image\/(?:png|jpeg);base64,/i, '');
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) return null;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { buffer, contentType: 'image/png', extension: 'png' };
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) {
    return { buffer, contentType: 'image/jpeg', extension: 'jpg' };
  }
  return null;
}

export function imageUrl(studyId, sensor, rowId, index = 0) {
  const path = `/api/v1/studies/${encodeURIComponent(studyId)}/media/${encodeURIComponent(sensor)}/${encodeURIComponent(rowId)}/image`;
  return index ? `${path}?image=${index}` : path;
}

export function expandPhotoRows(rows) {
  return rows.flatMap((row) => {
    const images = imageAnswers(row.data?.esm_user_answer);
    if (images.length <= 1) return [row];
    return images.map((image, index) => ({
      ...row, id: `${row.id}.${index}`, media_row_id: row.id, image_index: index,
      data: { ...row.data, esm_user_answer: image.buffer.toString('base64') },
    }));
  });
}
