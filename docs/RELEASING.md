# Publishing a Release

1. Update the version and changelog, then verify the branch CI passes.
2. Create an annotated tag `vMAJOR.MINOR.PATCH` on the validated commit.
3. Push the tag. The `Release` workflow rebuilds the API, generates an SPDX SBOM, publishes the
   image `ghcr.io/<owner>/<repo>/api`, and signs it keylessly with the GitHub OIDC identity.
4. Verify the Cosign signature, checksums, and SBOM before publishing GitHub release notes.

Verification example:

```bash
cosign verify ghcr.io/OWNER/REPOSITORY/api:v1.2.3 \
  --certificate-identity-regexp='https://github.com/OWNER/REPOSITORY/.github/workflows/release.yml' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
```

A release must contain no `.env`, browser profiles, local databases, backups, ACP credentials, or
user-specific paths. The root package remains `private: true` to prevent accidental npm publishing;
this does not restrict the open-source license of the repository.
