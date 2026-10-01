// Per-study informed consent.
//
// Researchers publish their ethics-approved consent from the researcher
// dashboard; the StudyTrace app shows it when a participant joins and only
// joins (and starts collecting) after the participant agrees. Each element
// App Store Guideline 5.1.3 requires of research consent is its own required
// field, so a published consent cannot leave one out.

export const CONSENT_TABLE = 'study_consent';

// key, label shown on the dashboard and in the app, required, max length.
export const CONSENT_FIELDS = [
  { key: 'title', label: 'Study title', required: true, max: 200 },
  { key: 'purpose', label: 'Purpose of the research', required: true, max: 4000 },
  { key: 'duration', label: 'How long participation lasts', required: true, max: 1000 },
  { key: 'procedures', label: 'What participants will do and what the app collects', required: true, max: 6000 },
  { key: 'risks', label: 'Risks and discomforts', required: true, max: 4000 },
  { key: 'benefits', label: 'Benefits', required: true, max: 4000 },
  { key: 'data_handling', label: 'Confidentiality, storage, and who can access the data', required: true, max: 6000 },
  { key: 'withdrawal', label: 'How to withdraw', required: true, max: 3000 },
  { key: 'contact_name', label: 'Contact person', required: true, max: 200 },
  { key: 'contact_email', label: 'Contact email', required: true, max: 200 },
  { key: 'contact_phone', label: 'Contact phone', required: false, max: 50 },
  { key: 'irb_name', label: 'Ethics board (IRB) that approved the study', required: true, max: 300 },
  { key: 'irb_protocol', label: 'Approval or protocol number', required: true, max: 200 },
  { key: 'additional', label: 'Anything else participants should know', required: false, max: 6000 },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Validates a dashboard submission. Returns the stored document; the version
// only increases when the wording changes, so re-saving the same text does
// not ask every participant to consent again.
export function buildConsentDocument(body, previous) {
  const doc = {};
  const missing = [];
  for (const field of CONSENT_FIELDS) {
    const value = String(body?.[field.key] ?? '').trim();
    if (value.length > field.max) {
      throw badRequest(`${field.label} must be at most ${field.max} characters`);
    }
    if (field.required && !value) missing.push(field.label);
    doc[field.key] = value;
  }
  if (missing.length) throw badRequest(`Required: ${missing.join(', ')}`);
  if (!EMAIL.test(doc.contact_email)) throw badRequest('Contact email must be an email address');

  const changed = !previous || CONSENT_FIELDS.some((field) => (previous[field.key] || '') !== doc[field.key]);
  if (!changed) return previous;
  return {
    ...doc,
    version: (Number(previous?.version) || 0) + 1,
    published_at: new Date().toISOString(),
  };
}

export function publishedConsent(study) {
  const consent = study?.config?.consent;
  return consent && consent.version ? consent : null;
}

// What the app receives: the document plus labels, so new fields can be
// added on the server without an app update.
export function consentForParticipant(study) {
  const consent = publishedConsent(study);
  if (!consent) return null;
  return {
    study_id: study.study_id,
    study_name: study.name,
    version: consent.version,
    published_at: consent.published_at,
    title: consent.title,
    sections: CONSENT_FIELDS
      .filter((field) => !['title', 'contact_name', 'contact_email', 'contact_phone', 'irb_name', 'irb_protocol'].includes(field.key))
      .filter((field) => consent[field.key])
      .map((field) => ({ key: field.key, heading: field.label, body: consent[field.key] })),
    contact: {
      name: consent.contact_name,
      email: consent.contact_email,
      phone: consent.contact_phone || null,
    },
    ethics: {
      board: consent.irb_name,
      protocol: consent.irb_protocol,
    },
  };
}
