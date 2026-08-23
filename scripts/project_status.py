#!/usr/bin/env python3
"""Positionne le champ Status (et d'autres) d'une issue sur le GitHub Project.

    python scripts/project_status.py <issue> <status> [--field Champ=Valeur ...]
    python scripts/project_status.py 42 "In progress"
    python scripts/project_status.py 42 Done --field Sprint=S2

Le workflow project-automation.yml fait normalement ce travail, mais il exige le
secret PROJECT_TOKEN (GITHUB_TOKEN ne peut pas écrire dans un projet
d'organisation). Tant que ce secret n'est pas posé, ce script est le seul
chemin qui tient la carte à jour — et il reste utile ensuite pour agir
immédiatement plutôt qu'à la latence du workflow.

Idempotent : si l'issue n'est pas encore dans le projet, elle y est ajoutée.
"""
import argparse
import json
import os
import subprocess
import sys

# La console Windows encode en cp1252 : sans cela, un simple accent dans un
# message de sortie fait planter le script APRÈS une mutation déjà appliquée.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

ORG = os.environ.get("SPA_PROJECT_ORG", "TMap-Works")
PROJECT_NUMBER = os.environ.get("SPA_PROJECT_NUMBER", "2")
REPO = os.environ.get("SPA_TRACKING_REPO", "TMap-Works/spa-booking")


def gql(query, **variables):
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        flag = "-F" if isinstance(value, (int, bool)) else "-f"
        args += [flag, f"{key}={value}"]
    proc = subprocess.run(args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        sys.exit(f"échec GraphQL : {proc.stderr.strip()}")
    payload = json.loads(proc.stdout)
    if "errors" in payload:
        sys.exit("erreurs GraphQL : " + json.dumps(payload["errors"], ensure_ascii=False))
    return payload["data"]


PROJECT_QUERY = """
query($org: String!, $num: Int!) {
  organization(login: $org) {
    projectV2(number: $num) {
      id
      fields(first: 30) {
        nodes {
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
    }
  }
}
"""

ITEM_QUERY = """
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      projectItems(first: 10) { nodes { id project { id } } }
    }
  }
}
"""

ADD_ITEM = """
mutation($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: {projectId: $project, contentId: $content}) {
    item { id }
  }
}
"""

SET_FIELD = """
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: {singleSelectOptionId: $option}
  }) { projectV2Item { id } }
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("issue", type=int)
    parser.add_argument("status", nargs="?", help="Backlog | Ready | In progress | In review | Done")
    parser.add_argument("--field", action="append", default=[],
                        metavar="CHAMP=VALEUR",
                        help="Champ à liste déroulante supplémentaire, ex. Sprint=S2")
    args = parser.parse_args()

    owner, repo = REPO.split("/")
    project = gql(PROJECT_QUERY, org=ORG, num=int(PROJECT_NUMBER))["organization"]["projectV2"]
    project_id = project["id"]

    fields = {}
    for node in project["fields"]["nodes"]:
        if node:
            fields[node["name"]] = (node["id"], {o["name"]: o["id"] for o in node["options"]})

    issue = gql(ITEM_QUERY, owner=owner, repo=repo, number=args.issue)["repository"]["issue"]
    if issue is None:
        sys.exit(f"issue #{args.issue} introuvable dans {REPO}")

    item_id = next(
        (n["id"] for n in issue["projectItems"]["nodes"] if n["project"]["id"] == project_id),
        None,
    )
    if item_id is None:
        item_id = gql(ADD_ITEM, project=project_id,
                      content=issue["id"])["addProjectV2ItemById"]["item"]["id"]
        print(f"issue #{args.issue} ajoutee au Project")

    updates = []
    if args.status:
        updates.append(("Status", args.status))
    for raw in args.field:
        if "=" not in raw:
            sys.exit(f"--field attend CHAMP=VALEUR, reçu : {raw}")
        name, value = raw.split("=", 1)
        updates.append((name.strip(), value.strip()))

    if not updates:
        sys.exit("rien à mettre à jour : donnez un statut ou au moins un --field")

    for name, value in updates:
        if name not in fields:
            sys.exit(f"champ « {name} » absent du Project (disponibles : {', '.join(fields)})")
        field_id, options = fields[name]
        if value not in options:
            sys.exit(f"valeur « {value} » absente du champ {name} "
                     f"(disponibles : {', '.join(options)})")
        gql(SET_FIELD, project=project_id, item=item_id,
            field=field_id, option=options[value])
        print(f"#{args.issue}  {name} -> {value}")


if __name__ == "__main__":
    main()
