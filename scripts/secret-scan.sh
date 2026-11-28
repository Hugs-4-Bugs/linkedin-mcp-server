#!/usr/bin/env bash
# Secret/pattern scan over tracked files (SECURITY_CHECKLIST: dependency and
# secret scans). Complements npm audit (supply chain) with a repo-content scan.
# Exit non-zero when a secret-like literal is found in tracked files.
set -euo pipefail

PATTERNS=(
  'AQS[A-Za-z0-9_%-]{20,}'                                    # LinkedIn access tokens (AQSr… / AQV…)
  'AQV[A-Za-z0-9_%-]{20,}'
  'sk-[A-Za-z0-9]{20,}'                                        # OpenAI-style keys
  'ghp_[A-Za-z0-9]{30,}'                                       # GitHub PATs
  'AKIA[0-9A-Z]{16}'                                           # AWS access key ids
  '-----BEGIN (RSA |EC )?PRIVATE KEY-----'
  'ey[A-Za-z0-9_-]{20,}\.ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}' # JWT triple
)

# Scan tracked AND untracked-but-present working files (a pre-commit run must
# see new files not yet staged — git ls-files alone gave a false clean once);
# ignored paths stay out via git check-ignore. Plus always-present env files.
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(git ls-files --cached --others --exclude-standard; echo .env; echo .env.local)

status=0
for pat in "${PATTERNS[@]}"; do
  for f in "${FILES[@]}"; do
    [[ -f "$f" ]] || continue
    if grep -nE "$pat" "$f" >/dev/null 2>&1; then
      echo "SECRET-PATTERN HIT: $f (pattern: $pat)"
      status=1
    fi
  done
done

if (( status != 0 )); then
  echo "secret scan FAILED"
  exit 1
fi
echo "secret scan clean"
