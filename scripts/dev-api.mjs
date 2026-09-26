// Start the API server on its own port during development.
//
// PORT is the web port for most tooling, and dev harnesses set it when they
// launch `npm run dev`. The API must not follow it there or it collides with
// Vite and every /api request 500s, so pin it unless API_PORT says otherwise.
process.env.PORT = process.env.API_PORT || '3001'
await import('../server.js')
