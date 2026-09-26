// Runs before each e2e test file is loaded (jest-e2e.json "setupFiles"), i.e.
// before AppModule's ConfigModule.forRoot() reads the environment.
// SQL logging from .env would drown the test output; E2E_DB_LOGGING=true shows it.
process.env.DB_LOGGING = process.env.E2E_DB_LOGGING ?? 'false';
