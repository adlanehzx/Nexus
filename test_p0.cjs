
(async () => {
  const login = await fetch('http://localhost:3000/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({email: 'claude@nexus.local', password: 'MotDePasseTresLongEtSecurise123!'})
  });
  const data = await login.json();
  const token = data.data.tokens.accessToken;
  
  const devs = await fetch('http://localhost:3000/api/v1/devices?limit=100', {
    headers: { 'Authorization': 'Bearer ' + token }
  });
  console.log('Devices:', devs.status, await devs.text());
})();

