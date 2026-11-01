(() => {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  const title = document.getElementById('join-card-title');
  const subtitle = document.getElementById('joinMissionSub');
  const form = document.getElementById('joinForm');
  const unavailable = document.getElementById('joinUnavailable');
  const unavailableMessage = document.getElementById('joinUnavailableMessage');
  const error = document.getElementById('joinError');
  const submit = document.getElementById('joinSubmit');

  function showUnavailable(message) {
    title.textContent = 'Link unavailable';
    subtitle.textContent = 'This invitation cannot be used.';
    form.hidden = true;
    unavailableMessage.textContent = message || 'This invitation is no longer available. Ask the operator for a new link.';
    unavailable.hidden = false;
  }

  async function post(path, body) {
    const response = await fetch('/api/v2/invitations/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), cache: 'no-store', referrerPolicy: 'no-referrer',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const failure = new Error(typeof data.detail === 'string' ? data.detail : 'Something went wrong. Please try again.');
      failure.status = response.status;
      throw failure;
    }
    return data;
  }

  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    showUnavailable('Open the full link shared by your operator.');
    return;
  }

  post('preview', { token }).then((invite) => {
    title.textContent = invite.title;
    subtitle.replaceChildren();
    const badge = document.createElement('span');
    badge.className = 'join-side ' + invite.side;
    badge.textContent = invite.side.toUpperCase() + ' TEAM';
    subtitle.append(badge, document.createTextNode(' · Your place is reserved'));
    form.hidden = false;
    document.getElementById('joinUsername').focus();
  }).catch((failure) => showUnavailable(failure.status === 404 ? failure.message : 'Unable to check the invitation. Please try again later.'));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.firstChild.textContent = 'Joining mission… ';
    try {
      const result = await post('redeem', {
        token,
        username: document.getElementById('joinUsername').value.trim(),
        password: document.getElementById('joinPassword').value,
      });
      localStorage.setItem('divide_token', result.token);
      window.history.replaceState(null, '', '/join');
      window.location.replace('/drill/');
    } catch (failure) {
      if (failure.status === 404) { showUnavailable(failure.message); return; }
      error.textContent = failure.message;
      error.hidden = false;
      submit.disabled = false;
      submit.firstChild.textContent = 'Create account & join ';
    }
  });
})();
