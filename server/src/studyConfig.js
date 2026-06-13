// Builds the study configuration JSON returned to the AWARE client when a
// device joins (POST to the study URL). The client (AWAREStudy.m) expects a
// JSON array whose first element contains "sensors" and "plugins" arrays of
// { "setting": <key>, "value": <value> } entries, which it applies via
// setSetting:.
//
// StudyTrace drives its own sensor enablement locally (AWARESlimConfiguration),
// so this config primarily needs to be well-formed and stable: the client
// compares it against the previously stored config to detect changes. We keep
// it minimal and deterministic.

export function buildStudyConfig({ studyId, studyName, webserviceUrl }) {
  return [
    {
      study_id: studyId,
      study_name: studyName || 'StudyTrace Study',
      study_description: 'StudyTrace research data collection',
      researcher_first: 'StudyTrace',
      researcher_last: 'Research',
      researcher_email: '',
      webservice_server: webserviceUrl,
      sensors: [
        { setting: 'status_webservice', value: 'true' },
        { setting: 'webservice_server', value: webserviceUrl },
        { setting: 'study_id', value: studyId },
      ],
      plugins: [
        {
          plugin: 'plugin_ios_esm',
          settings: [
            { setting: 'status_plugin_ios_esm', value: 'true' },
            { setting: 'plugin_ios_esm_config_url', value: `${webserviceUrl}/esm/config` },
            { setting: 'plugin_ios_esm_table_name', value: 'plugin_ios_esm' },
          ],
        },
      ],
    },
  ];
}
