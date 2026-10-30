// Study-specific context items, separate from the supplied validated instruments.
// Radio questions work on the currently supported iOS and Android clients.
export const CONTEXT_VERSION = 1;
const durationOptions = ['0 minutes', '1–15 minutes', '16–30 minutes', '31–45 minutes', '46–60 minutes', 'Not sure', 'Prefer not to answer'];

export function environmentContextQuestions() {
  const items = [
    ['setting', 'Where are you now?', ['Indoors', 'Outdoors', 'In a vehicle', 'Other', 'Prefer not to answer']],
    ['perceived_noise', 'How noisy is your current environment?', ['Very quiet', 'Quiet', 'Moderately noisy', 'Noisy', 'Very noisy', 'Prefer not to answer']],
    ['thermal_sensation', 'How does the temperature feel where you are now?', ['Very cold', 'Cold', 'Slightly cool', 'Neither cold nor hot', 'Slightly warm', 'Hot', 'Very hot', 'Prefer not to answer']],
    ['outdoor_minutes', 'During the past 60 minutes, approximately how many minutes did you spend outdoors?', durationOptions],
    ['nature_minutes', 'During the past 60 minutes, approximately how many minutes did you spend outdoors in a park, garden, woodland, or other green space?', durationOptions],
  ];
  return items.map(([measure, instructions, choices], index) => ({ esm: {
    esm_type: 2,
    esm_title: `Environment context ${index + 1}/${items.length}`,
    esm_instructions: instructions,
    esm_radios: [...choices],
    esm_trigger: `studytrace_context_${measure}_v${CONTEXT_VERSION}`,
    esm_submit: index === items.length - 1 ? 'Submit' : 'Next',
    esm_na: true,
    studytrace_required: false,
    studytrace_context_version: CONTEXT_VERSION,
    studytrace_context_measure: measure,
  } }));
}

export function withEnvironmentContext(study, schedules) {
  if (study?.config?.environment_collection?.enabled !== true ||
      study?.config?.environment_collection?.context_questions_enabled !== true) return schedules;
  return schedules.map(schedule => {
    const type = schedule?.studytrace_prompt_type;
    const id = String(schedule?.schedule_id || '').toLowerCase();
    if ((type && type !== 'esm_survey') || /battery|screen_time_activity|app_usage_screenshot/.test(id) ||
        !Array.isArray(schedule?.esms) || !schedule.esms.length) return schedule;
    // Regenerate just our own versioned items, so refreshes are idempotent.
    const original = schedule.esms.filter(item => !/^studytrace_context_(setting|perceived_noise|thermal_sensation|outdoor_minutes|nature_minutes)_v\d+$/.test(item?.esm?.esm_trigger || ''));
    if (!original.length) return schedule;
    const esms = structuredClone(original);
    esms[esms.length - 1].esm.esm_submit = 'Next';
    return { ...schedule, esms: [...esms, ...environmentContextQuestions()], studytrace_context_version: CONTEXT_VERSION };
  });
}
