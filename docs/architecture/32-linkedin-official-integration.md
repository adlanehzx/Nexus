# 32. Official LinkedIn Integration

NEXUS uses LinkedIn's official OAuth 2.0 and REST APIs. It does not scrape LinkedIn or drive
the website or Android application through accessibility automation.

## Initial scope

- OpenID Connect identity (`openid`, `profile`, `email`).
- Member publishing and comments (`w_member_social`).
- Every social mutation is a `HIGH`-risk NEXUS tool requiring explicit human confirmation.
- Access tokens are designed to be stored only through a `vault://nexus/...` reference.
- OAuth state is random, short-lived, and single-use.

Messaging, invitations, social-feed reads, job applications, and organization management are
not exposed unless LinkedIn grants the required partner permissions. NEXUS must never silently
fall back to browser or Android UI automation when an official permission is unavailable.

## Tools

| Tool                       | Permission              | Confirmation |
| -------------------------- | ----------------------- | ------------ |
| `linkedin.profile.read`    | `linkedin.profile.read` | No           |
| `linkedin.post.publish`    | `linkedin.social.write` | Mandatory    |
| `linkedin.comment.publish` | `linkedin.social.write` | Mandatory    |

The deployment operator must create a LinkedIn Developer application, configure the exact OAuth
redirect URI, and supply its client ID and secret through NEXUS configuration and the encrypted
vault. No credentials are committed to the repository.
