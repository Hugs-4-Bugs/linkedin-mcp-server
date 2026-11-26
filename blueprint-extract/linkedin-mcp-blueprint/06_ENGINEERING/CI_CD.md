# CI/CD

CI: install lockfile dependencies, lint, typecheck, tests, build, dependency/secret scan. Build immutable artifact/container. Deploy to staging first; smoke tests and rollback. Production deploy requires owner approval. Use least-privilege CI credentials, protected branches and required checks.
