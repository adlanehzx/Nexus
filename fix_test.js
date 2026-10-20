const fs = require("fs");
const code = `\ndescribe('CORS et CSP', () => {
  it('doit accepter un preflight valide', async () => {
    const response = await harness.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/login',
      headers: {
        Origin: 'http://localhost:5273',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5273');
    expect(response.headers['access-control-allow-methods']).toMatch(/POST/);
  });
});\n`;
fs.appendFileSync("services/api/test/rest.test.ts", code, "utf8");
