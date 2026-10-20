async function main() {
  const login2Res = await fetch("http://localhost:3000/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "claude@nexus.local",
      password: "MotDePasseTresLongEtSecurise123!",
    }),
  });
  console.log(await login2Res.text());
}
main();
