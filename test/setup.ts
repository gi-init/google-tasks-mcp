// Settings every test starts from. Tests that need a different setup change
// process.env themselves and restore it afterwards.
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.ALLOWED_EMAILS = "owner@example.com";
process.env.PUBLIC_URL = "https://tasks.example.com";
delete process.env.TOKEN_SECRET;
