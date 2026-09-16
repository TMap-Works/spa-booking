#!/usr/bin/env python3
"""Ouvre les tickets d'amélioration d'un audit de conception — le point
d'écriture unique du jalon « Design & UX ».

    python scripts/design_tickets.py grille
    python scripts/design_tickets.py open --critere ds:coherence --module catalog \
        --workstream Frontend --impact moyen --url /admin/catalogue \
        --titre "La liste du catalogue ne se lit pas comme celle du personnel" \
        --reference ".claude/skills/web-frontend/SKILL.md §6" \
        --attendu "..." --constate "..." --recommandation "..." --preuve "..." \
        --capture .claude/.recette/playwright/catalogue.png:"Les deux listes"
    python scripts/design_tickets.py voisins --url /admin/catalogue
    python scripts/design_tickets.py report --campagne d20260916-1

**Pourquoi un second script, alors que `qa_bugs.py` sait déjà ouvrir un ticket.**

Parce que les deux ne répondent pas à la même question, et qu'un ticket qui
mélange les deux ne se corrige pas.

| | `/qa` → `qa_bugs.py` | `/design-audit` → ce script |
|---|---|---|
| La question | un **seuil** est-il franchi ? | la conception **s'écarte-t-elle d'une référence écrite** ? |
| Le verdict | un défaut | un écart de conception |
| Le champ qui fait foi | `--mesure`, la valeur relevée | `--reference`, le document qui dit l'attendu |
| Le label | `type:bug` | `type:design` |
| Le jalon | « Bug & correction » | « Design & UX » |

Un même symptôme ne s'ouvre jamais des deux côtés : si un seuil de la grille de
QA est franchi, c'est un bug, et l'audit se contente de le signaler dans son
compte rendu. La sous-commande `voisins` sert à le vérifier avant d'ouvrir.

**Ce qui est réemployé, et pourquoi.** Toute la plomberie de `qa_bugs.py` — la
poussée des captures sur la branche orpheline, la déduplication par empreinte,
la carte de Project, la garde du jalon fermé. Elle a été écrite une fois, testée
une fois, et elle n'a rien de propre à la QA. Ce qui est réécrit ici est ce qui
change de sens : la grille, l'échelle d'impact, les champs obligatoires et le
corps du ticket.

**Ce que ce script garantit, et qu'il ne faut donc pas refaire à la main :**

- le **classement complet** — `type:design`, `nature:projet`, `ws:*`, `mod:*`,
  la priorité déduite de l'impact, le jalon. Une issue à qui manque un `ws:*`,
  un `mod:*` ou un `nature:*` est écartée du plan par `milestone_plan.py` **sans
  qu'aucun message ne le dise** ;
- la **référence obligatoire** — un constat de conception qui ne s'appuie sur
  aucun document écrit est un goût personnel, et un goût personnel n'a pas à
  devenir un ticket que quelqu'un devra corriger ;
- la **recommandation obligatoire** — un ticket qui dit ce qui ne va pas sans
  dire vers quoi aller renvoie la conception à l'agent de correction,
  c'est-à-dire au moins qualifié pour la faire ;
- la **déduplication** — même critère, même endroit, même clé, donc même
  empreinte. Un audit se rejoue ; le même écart ne doit pas ouvrir deux tickets ;
- la **preuve visuelle** — refus d'ouvrir sans `--capture` ni `--sans-capture`.

Codes de sortie : 0 fait · 1 échec d'environnement (gh, git, réseau) ·
4 erreur d'appel.
"""
import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qa_bugs as qa  # noqa: E402  — la plomberie partagée, importée telle quelle

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

ROOT = qa.ROOT
REPO = qa.REPO
OK, FAIL, USAGE = qa.OK, qa.FAIL, qa.USAGE
DesignError = qa.QaError

JALON = os.environ.get("SPA_DESIGN_MILESTONE", "Design & UX")

# La famille sépare les captures des deux dispositifs sur la branche d'images :
# `docs/design/captures/` ici, `docs/qa/captures/` pour la QA.
FAMILLE = "design"

DESCRIPTION_JALON = (
    "Améliorations de conception relevées par les audits design "
    "(/design-audit). Sans échéance : ce jalon ne doit pas se substituer au "
    "sprint en cours dans tracking.py."
)

LABEL_TYPE = "type:design"
LABEL_TYPE_COULEUR = "C8A2C8"
LABEL_TYPE_DESCRIPTION = ("Écart de conception relevé par un audit design — "
                          "amélioration, pas défaut")

# ---------------------------------------------------------------------------
# La grille
# ---------------------------------------------------------------------------
# Les critères de l'audit, et rien d'autre. Ils sont exactement ceux de
# `.claude/skills/design-audit/SKILL.md` §3 — un test (`Grille`) échoue si les
# deux listes divergent, parce qu'un agent qui invoque un critère que le script
# refuse perd son constat au moment de l'ouvrir.
#
# Aucun ne recoupe la grille de QA : là où `fe:responsive` mesure un
# débordement, `ds:mobile` juge une conception ; là où `fe:ux` relève un état
# manquant à l'écran, `ds:parcours` relève un enchaînement qui ne mène pas où le
# cahier des charges dit qu'il doit mener.
CRITERES = {
    "ds:parcours": "enchaînement des étapes — ordre, retour arrière, reprise, sorties",
    "ds:hierarchie": "hiérarchie de l'information — ce qu'on voit d'abord, l'action principale",
    "ds:systeme": "conformité au design system — jetons, composants de components/ui/",
    "ds:coherence": "cohérence d'un écran à l'autre — mêmes objets, mêmes gestes, mêmes mots",
    "ds:libelles": "microcopie — libellés, messages, vocabulaire métier du CDC",
    "ds:etats": "états de l'écran — vide, chargement, erreur, succès, première utilisation",
    "ds:mobile": "conception mobile d'abord du parcours client — 360 px comme point de départ",
    "ds:a11y": "accessibilité de conception — ce qu'un choix de conception exclut",
    "ds:confiance": "ce qui permet de décider — prix, durée, annulation, identité du salon",
}

# L'impact, et la priorité qu'il vaut. Trois cases, et `P0` n'en fait pas
# partie : un audit de conception ne bloque personne — ce qui bloque est un bug,
# et c'est `/qa` qui l'ouvre. `P1` est réservé à ce qui **contredit une
# référence écrite** sur un parcours du MVP ; sans cette borne, tout écart de
# conception finirait en P1 et l'ordre du run ne voudrait plus rien dire.
IMPACTS = {
    "fort": ("P1", "contredit une référence écrite sur un parcours du MVP"),
    "moyen": ("P2", "dégrade l'usage sans l'empêcher"),
    "faible": ("P2", "finition — à regrouper par écran plutôt qu'à ouvrir seul"),
}

# Les formes d'une référence recevable. Ce n'est pas une exigence de format :
# c'est le garde-fou qui distingue un constat d'audit d'une opinion. Un chemin
# du dépôt n'est accepté que s'il existe réellement — une référence inventée
# serait pire qu'une référence absente.
REFERENCE_CDC = re.compile(r"\bcdc\b[^\n]{0,24}§\s*[\d.]+", re.I)
REFERENCE_ADR = re.compile(r"\badr\b[^\n]{0,12}\d{1,4}", re.I)
REFERENCE_NORME = re.compile(r"\bwcag\b|\brgaa\b", re.I)
# Les parenthèses et les crochets sont dans la classe parce que les routes Next
# en portent : `app/(admin)/[tenantSlug]/…`. Sans eux, le chemin cité était
# tronqué à son dernier segment, qui n'existe pas seul — et la garde refusait
# une référence juste. Même raison pour `html` : les maquettes du dépôt vivent
# dans `apps/web/mockups/` et font référence. Les deux manques ont été trouvés
# en menant le premier audit (d20260916-1), pas en relisant le code.
REFERENCE_CHEMIN = re.compile(
    r"[\w./\\()\[\]-]+\.(?:md|css|tsx|ts|mjs|txt|json|html)")


def valider(critere, module, workstream, impact):
    """Tout est refusé **avant** l'appel à `gh`, comme dans `qa_bugs.py` : un
    ticket à moitié créé puis corrigé après coup laisse une notification fausse
    et une carte de Project au mauvais endroit.
    """
    if critere not in CRITERES:
        raise DesignError(
            f"critère inconnu : {critere}\n"
            f"attendus : {', '.join(sorted(CRITERES))}\n"
            "Un critère hors grille n'est pas un constat d'audit : c'est une "
            "opinion.", USAGE)
    if module not in qa.MODULES:
        raise DesignError(f"module inconnu : {module}\n"
                          f"attendus : {', '.join(qa.MODULES)}", USAGE)
    if workstream not in qa.WORKSTREAMS:
        raise DesignError(f"workstream inconnu : {workstream}\n"
                          f"attendus : {', '.join(qa.WORKSTREAMS)}", USAGE)
    if impact not in IMPACTS:
        raise DesignError(f"impact inconnu : {impact}\n"
                          f"attendus : {', '.join(IMPACTS)}", USAGE)


def valider_reference(reference):
    """Une référence recevable pointe quelque chose qu'un relecteur peut ouvrir.

    Quatre formes, et une seule suffit : une section du cahier des charges, un
    ADR, une norme d'accessibilité, ou un fichier du dépôt qui **existe**. Le
    contrôle d'existence est ce qui empêche la forme la plus commode de dériver :
    citer `apps/web/styles/design.css` est facile, et ce fichier n'existe pas.
    """
    texte = (reference or "").strip()
    if not texte:
        raise DesignError("référence vide.", USAGE)
    if (REFERENCE_CDC.search(texte) or REFERENCE_ADR.search(texte)
            or REFERENCE_NORME.search(texte)):
        return texte

    candidats = REFERENCE_CHEMIN.findall(texte)
    for brut in candidats:
        # `lstrip("./")` mangerait le point de `.claude/…` — il retire un
        # *ensemble* de caractères, pas un préfixe. La moitié des références
        # utiles du dépôt vivent sous `.claude/`.
        chemin = re.sub(r"^\./", "", brut.replace("\\", "/"))
        if (ROOT / chemin).is_file():
            return texte

    detail = (f"\nChemins cités, aucun trouvé dans le dépôt : "
              f"{', '.join(candidats)}" if candidats else "")
    raise DesignError(
        f"référence irrecevable : {texte}{detail}\n"
        "Un constat de conception s'appuie sur un document écrit, sinon c'est "
        "un goût personnel. Formes acceptées :\n"
        "  - une section du cahier des charges : CDC §1.4\n"
        "  - un ADR                            : ADR 0006\n"
        "  - une norme d'accessibilité         : WCAG 2.2 AA, 1.4.3\n"
        "  - un fichier du dépôt qui existe    : apps/web/styles/tokens.css, "
        ".claude/skills/web-frontend/SKILL.md §6",
        USAGE)


def labels_for(impact, module, workstream):
    priorite, _ = IMPACTS[impact]
    return [LABEL_TYPE, "nature:projet", qa.WORKSTREAMS[workstream],
            f"mod:{module}", priorite]


def ensure_label(verbeux=True):
    """Le label `type:design` n'existe pas d'origine dans le dépôt : sans lui,
    `gh issue create` échoue et l'audit s'arrête sur son premier ticket.
    Idempotent, comme le jalon.
    """
    presents = {e["name"] for e in (qa.gh_json(
        ["label", "list", "--repo", REPO, "--limit", "200",
         "--json", "name"]) or [])}
    if LABEL_TYPE in presents:
        return False
    qa.gh(["label", "create", LABEL_TYPE, "--repo", REPO,
           "--color", LABEL_TYPE_COULEUR,
           "--description", LABEL_TYPE_DESCRIPTION])
    if verbeux:
        print(f"label « {LABEL_TYPE} » créé")
    return True


def ensure_milestone(verbeux=True):
    return qa.ensure_milestone(verbeux=verbeux, titre=JALON,
                               description=DESCRIPTION_JALON)


def issues_du_jalon(etat="all"):
    return qa.issues_du_jalon(etat, titre=JALON)


def campagne_du_jour(suffixe=1):
    """`d` en tête : une campagne de QA et un audit menés le même jour ne
    portent pas le même identifiant, et un `report` ne mélange jamais les deux.
    """
    return "d" + qa.campagne_du_jour(suffixe)


# ---------------------------------------------------------------------------
# Le corps du ticket
# ---------------------------------------------------------------------------

def corps(constat, captures, doublon_ferme=None):
    """Ce qu'un agent de correction doit lire pour travailler sans revenir vers
    l'humain. L'ordre n'est pas décoratif : la **référence** d'abord — sans
    elle, l'attendu n'est qu'une préférence de plus —, puis l'attendu, le
    constaté, et seulement ensuite la direction proposée.
    """
    libelle = CRITERES[constat["critere"]]
    priorite, sens = IMPACTS[constat["impact"]]

    lignes = [
        f"> **Audit design `{constat['campagne']}`** — critère "
        f"`{constat['critere']}` · impact **{constat['impact']}** (`{priorite}`)",
        "",
        "## La référence", "",
        constat["reference"], "",
        "## Ce qu'elle prescrit", "",
        constat["attendu"], "",
        "## Ce que l'écran fait", "",
        constat["constate"], "",
        "## La direction proposée", "",
        constat["recommandation"], "",
    ]

    if constat.get("portee"):
        lignes += ["## Portée", "",
                   "L'écart se retrouve à l'identique sur :", ""]
        lignes += [f"- `{p}`" for p in constat["portee"]]
        lignes += [""]

    lignes += ["## Preuve", "", "```", constat["preuve"].rstrip(), "```", ""]

    lignes += ["## Preuve visuelle", ""]
    if captures:
        for url, legende in captures:
            lignes.append(f"![{legende or 'capture de audit design'}]({url})")
            if legende:
                lignes.append(f"*{legende}*")
            lignes.append("")
    else:
        lignes += [f"_Aucune capture — {constat['sans_capture']}_", ""]

    lignes += [
        "## Critère", "",
        f"`{constat['critere']}` — {libelle}.",
        f"Impact **{constat['impact']}** ({sens}) → `{priorite}`.",
        "",
        "Grille de référence : "
        "[.claude/skills/design-audit/SKILL.md](.claude/skills/design-audit/SKILL.md).",
        "",
    ]

    if doublon_ferme:
        lignes += [
            "## Déjà vu", "",
            f"Cet écart avait déjà été traité en #{doublon_ferme} — même "
            "empreinte, ticket fermé. Lire d'abord ce qui y avait été décidé : "
            "un écart qui revient dit souvent que la correction précédente n'a "
            "pas été portée au bon endroit.",
            "",
        ]

    lignes += [
        "---", "",
        f"Audit `{constat['campagne']}` · relevé le {constat['date']} · "
        f"écran `{constat['url']}`",
        "",
        # La marque reste celle de `qa_bugs.py` : c'est sa recherche de doublon
        # qui la lit. Le préfixe nomme la plomberie, pas le dispositif.
        f"{qa.MARQUE_EMPREINTE}{constat['empreinte']} -->",
    ]
    return "\n".join(lignes)


# ---------------------------------------------------------------------------
# Les sous-commandes
# ---------------------------------------------------------------------------

def cmd_open(args):
    valider(args.critere, args.module, args.workstream, args.impact)
    reference = valider_reference(args.reference)

    if not args.capture and not args.sans_capture:
        raise DesignError(
            "aucune capture, et aucune raison de ne pas en avoir.\n"
            "Un constat de conception sans image ne se relit pas : ce qui se "
            "juge à l'oeil doit se montrer.\n"
            "  --capture <chemin.png>[:légende]   (répétable)\n"
            "  --sans-capture \"<pourquoi il n'y en a pas>\"", USAGE)

    fichiers = [qa.parse_capture(brut) for brut in (args.capture or [])]
    marque = qa.empreinte(args.critere, args.module, args.url, args.cle or "")
    campagne = args.campagne or campagne_du_jour()

    constat = {
        "titre": args.titre.strip(),
        "critere": args.critere, "module": args.module,
        "workstream": args.workstream, "impact": args.impact,
        # `nettoyer_url` rattrape la conversion de chemin de Git Bash : un
        # `--url /reservation` y arrive en `C:/Program Files/Git/reservation`.
        "url": qa.nettoyer_url(args.url), "reference": reference,
        "attendu": args.attendu.strip(), "constate": args.constate.strip(),
        "recommandation": args.recommandation.strip(),
        "preuve": args.preuve.strip(),
        "portee": [p.strip() for p in (args.portee or []) if p.strip()],
        "sans_capture": (args.sans_capture or "").strip(),
        "campagne": campagne, "empreinte": marque,
        "date": f"{datetime.now(timezone.utc):%d/%m/%Y}",
    }
    etiquettes = labels_for(args.impact, args.module, args.workstream)

    if args.dry_run:
        # Mêmes gardes que l'appel réel — un essai à blanc qui accepterait une
        # capture introuvable rendrait un ticket parfait, et l'appel réel
        # échouerait sur chaque constat derrière lui.
        fichiers = qa.verifier_captures(fichiers)
        futures = [(qa.url_capture(campagne, marque, rang, chemin, FAMILLE),
                    legende)
                   for rang, (chemin, legende) in enumerate(fichiers, start=1)]
        print(json.dumps({
            "titre": constat["titre"], "labels": etiquettes, "milestone": JALON,
            "empreinte": marque, "campagne": campagne,
            "captures": [str(c) for c, _ in fichiers],
            "corps": corps(constat, futures),
        }, ensure_ascii=False, indent=2))
        return OK

    ensure_milestone(verbeux=False)
    ensure_label(verbeux=False)
    connues = issues_du_jalon()
    existant, etat, url = qa.chercher_doublon(marque, connues)

    if existant and etat == "open":
        qa.gh(["issue", "comment", str(existant), "--repo", REPO, "--body",
               f"Retrouvé par l'audit `{campagne}` du {constat['date']} — "
               f"toujours présent sur `{constat['url']}`.\n\n"
               f"Aucun nouveau ticket ouvert : même empreinte `{marque}`."])
        print(json.dumps({"issue": existant, "url": url, "doublon": True,
                          "empreinte": marque}, ensure_ascii=False))
        return OK

    captures = qa.pousser_captures(fichiers, campagne, marque, FAMILLE)
    body = corps(constat, captures,
                 doublon_ferme=existant if etat == "closed" else None)

    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False,
                                     encoding="utf-8") as fichier:
        fichier.write(body)
        chemin_corps = fichier.name
    try:
        cree = qa.gh(["issue", "create", "--repo", REPO,
                      "--title", constat["titre"], "--body-file", chemin_corps,
                      "--milestone", JALON,
                      *sum((["--label", e] for e in etiquettes), [])]).strip()
    finally:
        os.unlink(chemin_corps)

    numero = int(cree.rstrip("/").rsplit("/", 1)[-1])
    sur_le_board = qa.poser_la_carte(numero, args.module, args.workstream,
                                     IMPACTS[args.impact][0])
    print(json.dumps({"issue": numero, "url": cree.splitlines()[-1].strip(),
                      "labels": etiquettes, "milestone": JALON,
                      "empreinte": marque, "campagne": campagne,
                      "captures": [u for u, _ in captures],
                      "project": sur_le_board,
                      "revu_de": existant if etat == "closed" else None},
                     ensure_ascii=False))
    return OK


def cmd_voisins(args):
    """Ce qui est **déjà ouvert** sur cet écran, des deux côtés.

    La question à laquelle cette sous-commande répond est la seule qui empêche
    les deux dispositifs de se doubler : avant d'ouvrir un ticket de conception
    sur `/reservation`, la QA y a-t-elle déjà ouvert un bug qui dit la même
    chose ? Si oui, c'est un bug — l'audit le signale et n'ouvre rien.
    """
    cible = qa.normaliser_url(args.url)
    trouves = []
    for jalon in (JALON, qa.JALON):
        for issue in qa.issues_du_jalon("open", titre=jalon):
            corps_issue = issue.get("body") or ""
            match = re.search(r"écran `([^`]+)`|endroit `([^`]+)`", corps_issue)
            endroit = next((g for g in (match.groups() if match else ()) if g), "")
            if qa.normaliser_url(endroit) != cible:
                continue
            trouves.append({
                "jalon": jalon, "issue": issue["number"],
                "titre": issue["title"], "url": issue.get("url"),
                "empreinte": qa.extraire_empreinte(corps_issue),
            })

    if args.json:
        print(json.dumps(trouves, ensure_ascii=False, indent=2))
        return OK
    if not trouves:
        print(f"`{cible}` : aucun ticket ouvert, ni en audit ni en QA.")
        return OK
    print(f"`{cible}` — {len(trouves)} ticket(s) ouvert(s) :")
    for t in trouves:
        print(f"  #{t['issue']:<5} [{t['jalon']}] {t['titre']}")
    return OK


def cmd_list(args):
    issues = issues_du_jalon(args.state)
    if args.json:
        print(json.dumps([{**i, "empreinte": qa.extraire_empreinte(i.get("body"))}
                          for i in issues], ensure_ascii=False, indent=2))
        return OK
    if not issues:
        print(f"jalon « {JALON} » : aucun écart de conception.")
        return OK
    print(f"Jalon « {JALON} » · {len(issues)} écart(s)")
    for issue in issues:
        etat = "ouvert" if issue["state"].lower() == "open" else "fermé"
        print(f"  #{issue['number']:<5} [{etat:<6}] {issue['title']}")
    return OK


def cmd_report(args):
    """Le tableau que `/design-audit` publie en fin d'audit. Il ne raconte pas
    ce que l'audit a fait : il dit ce qu'il a **laissé à reprendre**.
    """
    issues = issues_du_jalon("open")
    if args.campagne:
        issues = [i for i in issues
                  if f"Audit `{args.campagne}`" in (i.get("body") or "")]

    par_rang = {"P1": [], "P2": [], "?": []}
    for issue in issues:
        noms = {e["name"] for e in (issue.get("labels") or [])}
        rang = next((p for p in ("P1", "P2") if p in noms), "?")
        par_rang[rang].append(issue)

    titre = f"Audit `{args.campagne}`" if args.campagne else f"Jalon « {JALON} »"
    print(f"### {titre} — {len(issues)} écart(s) ouvert(s)\n")
    if not issues:
        print("Aucun écart ouvert. Rien à reprendre.")
        return OK
    print("| Priorité | Ticket | Écart |")
    print("|---|---|---|")
    for rang in ("P1", "P2", "?"):
        for issue in par_rang[rang]:
            print(f"| `{rang}` | #{issue['number']} | {issue['title']} |")
    print(f"\nDérouler les reprises : `/milestone \"{JALON}\"`.")
    return OK


def cmd_grille(args):
    """La grille telle que le script l'applique — pas telle qu'on s'en souvient.
    Un agent qui la lit ici ne peut pas inventer un critère.
    """
    if args.json:
        print(json.dumps({"criteres": CRITERES,
                          "impacts": {k: {"priorite": v[0], "sens": v[1]}
                                      for k, v in IMPACTS.items()},
                          "jalon": JALON}, ensure_ascii=False, indent=2))
        return OK
    print(f"Grille de l'audit design — jalon « {JALON} »\n")
    for critere, libelle in CRITERES.items():
        print(f"  {critere:<16} {libelle}")
    print("\nImpact -> priorité")
    for impact, (priorite, sens) in IMPACTS.items():
        print(f"  {impact:<8} -> {priorite}   {sens}")
    return OK


def cmd_ensure_milestone(args):
    ensure_milestone()
    ensure_label()
    return OK


# ---------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(
        prog="design_tickets.py",
        description="Point d'écriture des tickets d'amélioration du jalon "
                    f"« {JALON} ».")
    sous = parser.add_subparsers(dest="commande", required=True)

    sous.add_parser("ensure-milestone",
                    help="créer le jalon et le label type:design (idempotent)")

    grille = sous.add_parser("grille", help="afficher la grille appliquée")
    grille.add_argument("--json", action="store_true")

    ouvrir = sous.add_parser("open",
                             help="ouvrir le ticket d'un constat d'audit")
    ouvrir.add_argument("--titre", required=True,
                        help="l'écart en une phrase, pas « améliorer la page »")
    ouvrir.add_argument("--critere", required=True,
                        help=f"un critère de la grille : {', '.join(sorted(CRITERES))}")
    ouvrir.add_argument("--module", required=True, choices=qa.MODULES)
    ouvrir.add_argument("--workstream", default="Frontend",
                        choices=sorted(qa.WORKSTREAMS),
                        help="Frontend par défaut — la correction vit dans "
                             "apps/web. Design ne se justifie que si le "
                             "livrable est une maquette ou une spec de "
                             "docs/design/")
    ouvrir.add_argument("--impact", required=True, choices=sorted(IMPACTS))
    ouvrir.add_argument("--url", required=True, help="l'écran où l'écart se voit")
    ouvrir.add_argument("--reference", required=True,
                        help="le document qui dit ce qui est attendu — "
                             "CDC §x, ADR n, WCAG, ou un fichier du dépôt")
    ouvrir.add_argument("--attendu", required=True,
                        help="ce que la référence prescrit, en clair")
    ouvrir.add_argument("--constate", required=True,
                        help="ce que l'écran fait à la place")
    ouvrir.add_argument("--recommandation", required=True,
                        help="la direction proposée — pas le code, la direction")
    ouvrir.add_argument("--preuve", required=True,
                        help="verbatim : ce qui a été vu, où, à quelle largeur")
    ouvrir.add_argument("--portee", action="append",
                        help="autre écran où l'écart se retrouve (répétable)")
    ouvrir.add_argument("--capture", action="append",
                        help="chemin[:légende] — répétable")
    ouvrir.add_argument("--sans-capture", dest="sans_capture",
                        help="pourquoi ce constat n'a pas d'image")
    ouvrir.add_argument("--cle", default="",
                        help="discriminant si deux écarts du même critère "
                             "cohabitent sur le même écran")
    ouvrir.add_argument("--campagne", help="identifiant de l'audit (dAAAAMMJJ-N)")
    ouvrir.add_argument("--dry-run", action="store_true",
                        help="montrer le ticket sans l'ouvrir")

    voisins = sous.add_parser(
        "voisins",
        help="les tickets déjà ouverts sur un écran, audit et QA compris")
    voisins.add_argument("--url", required=True)
    voisins.add_argument("--json", action="store_true")

    lister = sous.add_parser("list", help="les tickets du jalon")
    lister.add_argument("--state", default="all",
                        choices=("open", "closed", "all"))
    lister.add_argument("--json", action="store_true")

    rapport = sous.add_parser("report", help="le tableau de fin d'audit")
    rapport.add_argument("--campagne")

    return parser


COMMANDES = {
    "ensure-milestone": cmd_ensure_milestone,
    "grille": cmd_grille,
    "open": cmd_open,
    "voisins": cmd_voisins,
    "list": cmd_list,
    "report": cmd_report,
}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return COMMANDES[args.commande](args)
    except DesignError as erreur:
        print(f"design_tickets : {erreur}", file=sys.stderr)
        return erreur.code


if __name__ == "__main__":
    sys.exit(main())
