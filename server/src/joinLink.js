// Participant join links: the AWARE-protocol study URL the StudyTrace app
// joins with, plus a QR code of it for scanning in the app.
//
// The participant password is stored hashed, so a link can only be built when
// the caller supplies that password (on study creation, or when an admin or
// researcher asks for a link and the password checks out).

import qrcode from 'qrcode-generator';

const MAX_PARTICIPANT_LENGTH = 128;

export function normalizeParticipantLabel(value) {
  const label = String(value ?? '').trim();
  if (!label) return '';
  if (label.length > MAX_PARTICIPANT_LENGTH) {
    const err = new Error(`participant must be at most ${MAX_PARTICIPANT_LENGTH} characters`);
    err.statusCode = 400;
    throw err;
  }
  return label;
}

export function studyJoinUrl(base, studyId, password, participant) {
  const url = `${base}/index.php/webservice/index/${encodeURIComponent(studyId)}/${encodeURIComponent(password)}`;
  return participant ? `${url}?participant=${encodeURIComponent(participant)}` : url;
}

const QR_CELL_PX = 8;

// Standalone SVG document (rendered by the dashboards as an <img>). The margin
// option is in pixels; QR readers expect a quiet zone of 4 modules.
export function qrCodeSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: QR_CELL_PX, margin: QR_CELL_PX * 4 });
}

export function buildJoinLink(base, studyId, password, participant) {
  const label = normalizeParticipantLabel(participant);
  const studyUrl = studyJoinUrl(base, studyId, password, label);
  return {
    study_id: studyId,
    participant: label || null,
    study_url: studyUrl,
    qr_svg: qrCodeSvg(studyUrl),
  };
}
