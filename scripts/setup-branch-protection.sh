#!/usr/bin/env bash
# Protection des branches permanentes (BRANCHING.md).
#
# Les rulesets sur dépôt privé exigent GitHub Pro, Team ou Enterprise. Sur le
# plan Free actuel de l'organisation, l'appel renvoie 403 : c'est attendu.
# Lancer ce script après une montée de plan, ou après passage du dépôt en public.
#
#   bash scripts/setup-branch-protection.sh

set -euo pipefail
REPO="${REPO:-TMap-Works/spa-booking}"

ruleset() {
  local name="$1" branch="$2" approvals="$3" codeowners="$4"
  gh api -X POST "repos/$REPO/rulesets" --input - <<JSON
{
  "name": "$name",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/$branch"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": $approvals,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": $codeowners,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Lint & types" },
          { "context": "Tests" },
          { "context": "Build" },
          { "context": "Messages de commit" },
          { "context": "Conventions de PR" },
          { "context": "Fuite de secrets" }
        ]
      }
    }
  ]
}
JSON
  echo "  ruleset '$name' appliqué sur $branch"
}

echo "Protection des branches de $REPO"
ruleset "protect-main"    main    2 true
ruleset "protect-staging" staging 1 true
ruleset "protect-develop" develop 1 false
echo "Terminé."
