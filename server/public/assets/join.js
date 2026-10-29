const raw = new URLSearchParams(location.search).get('url');
try {
  const study = new URL(raw);
  if (study.protocol !== 'https:' || study.username || study.password) throw new Error('invalid study URL');
  document.querySelector('#study-url').value = study.href;
  document.querySelector('#open-studytrace').href = `studytrace://join?${new URLSearchParams({ url: study.href })}`;
} catch {
  document.querySelector('h1').textContent = 'Ask your research team for a valid study link';
}
