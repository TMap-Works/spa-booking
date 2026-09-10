#!/usr/bin/env python3
"""Ouvre les tickets d'anomalie d'une campagne de QA — le point d'écriture unique
du jalon « Bug & correction ».

    python scripts/qa_bugs.py ensure-milestone
    python scripts/qa_bugs.py open --critere fe:responsive --module appointments \\
        --workstream Frontend --gravite majeur --url /reserver/creneaux \\
        --titre "Le calendrier déborde de la fenêtre à 360 px" \\
        --attendu "..." --constate "..." --preuve "..." \\
        --capture .claude/.recette/playwright/360.png:"Le calendrier coupé à droite"
    python scripts/qa_bugs.py list --json
    python scripts/qa_bugs.py report --campagne 20260910-1

Pourquoi un script plutôt qu'un `gh issue create` libre. Trois raisons, et
aucune n'est cosmétique.

**1. Un ticket mal étiqueté n'est jamais déroulé.** `milestone_plan.py` écarte du
plan toute issue à qui manque un `ws:*`, un `mod:*` ou un `nature:*` — sans un
mot, elle sort du jalon pour « classement incomplet ». Une campagne de QA qui
ouvrirait trente tickets à la main en perdrait une partie en silence : le run de
correction ne les verrait pas, et personne ne saurait pourquoi. Ici, le
classement n'est pas facultatif — il est validé avant l'appel à `gh`.

**2. Une campagne se rejoue.** Le même défaut retrouvé la semaine suivante ne
doit pas ouvrir un second ticket. Chaque constat porte donc une **empreinte** —
critère + module + URL + clé de discrimination — écrite dans le corps de
l'issue. Une empreinte déjà ouverte fait commenter le ticket existant plutôt
qu'en créer un jumeau ; une empreinte déjà **fermée** ouvre un ticket de
régression qui cite l'ancien. C'est la différence entre un jalon exploitable et
un dépotoir de doublons.

**3. La preuve doit survivre au transcript.** Un constat de QA sans capture n'est
pas relisible : « l'espacement est faux » ne se vérifie pas six jours plus tard.
`open` refuse donc un ticket sans `--capture`, à moins d'un `--sans-capture
"<raison>"` explicite — et la raison est alors écrite dans le corps, à la vue du
relecteur.

**Où vont les captures.** Sur une branche `qa-captures` qui ne merge jamais,
écrite en **plomberie git** (`hash-object`, `write-tree`, `commit-tree`) : aucun
`checkout`, donc aucun arbre matérialisé sur le disque — le poste a déjà connu
la saturation (#509). Le dépôt étant public, l'URL `raw.githubusercontent.com`
qui en résulte s'affiche en ligne dans le corps de l'issue, sans jeton.
La release d'attachements ferait aussi bien, mais `gh release create` est une
publication : le classifieur de permissions la retient, et un run non interactif
resterait bloqué dessus.

Codes de sortie : 0 fait · 1 échec d'environnement (gh, git, réseau) ·
4 erreur d'appel.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

# La console Windows encode en cp1252 : sans cela, un accent dans un titre de
# constat fait planter le script au moment de l'afficher.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

ROOT = Path(__file__).resolve().parents[1]
REPO = os.environ.get("SPA_QA_REPO", "TMap-Works/spa-booking")
JALON = os.environ.get("SPA_QA_MILESTONE", "Bug & correction")
BRANCHE_CAPTURES = os.environ.get("SPA_QA_CAPTURES_BRANCH", "qa-captures")

OK, FAIL, USAGE = 0, 1, 4

# Deux mégaoctets par capture. Ce n'est pas une limite technique de GitHub :
# c'est ce qui empêche une campagne distraite de pousser des captures 4K sur une
# branche que personne ne relit. Une capture de page pèse 100 à 300 Ko.
TAILLE_MAX_CAPTURE = 2 * 1024 * 1024

# La gravité est ce que l'agent de QA sait dire ; la priorité est ce que le plan
# sait lire. La table les relie une fois pour toutes, plutôt que de laisser
# chaque agent inventer sa correspondance.
GRAVITES = {
    "bloquant": ("P0", "empêche d'accomplir la tâche, ou expose une donnée"),
    "majeur": ("P1", "dégrade nettement l'usage, contourne mal"),
    "mineur": ("P2", "visible, sans conséquence sur la tâche"),
}

MODULES = ("identity", "catalog", "availability", "appointments", "crm",
           "payments", "notifications", "reporting", "infra")

WORKSTREAMS = {
    "Backend": "ws:backend",
    "Frontend": "ws:frontend",
    "DevOps": "ws:devops",
    "Design": "ws:design",
    "QA": "ws:qa",
}

# Les critères de la grille — ceux de `.claude/skills/qa/SKILL.md`, et rien
# d'autre. Un constat qui ne se rattache à aucun d'eux n'est pas un constat de
# QA : c'est une opinion, et elle n'a pas à devenir un ticket que quelqu'un
# devra corriger. Le libellé sert au corps de l'issue.
CRITERES = {
    "fe:design": "cohérence visuelle — palette, typographie, composants du design system",
    "fe:espacement": "échelle d'espacement — rythme vertical, gouttières, densité",
    "fe:positionnement": "alignement et débordement — chevauchement, coupure, ancrage",
    "fe:responsive": "adaptation aux largeurs 360, 768, 1280 et 1920 px",
    "fe:ux": "parcours et libellés — états vide, en chargement, en erreur",
    "fe:a11y": "accessibilité — contraste, focus visible, libellés, ordre de tabulation",
    "fe:performance": "coût d'affichage — poids transféré, nombre de requêtes, délai",
    "fe:console": "propreté d'exécution — erreurs de console, requêtes en échec",
    "be:securite": "authentification, autorisation, isolation du tenant, exposition de données",
    "be:validation": "validation des entrées et forme de l'erreur rendue",
    "be:latence": "temps de réponse de la route au regard de sa classe",
    "be:performance": "coût serveur — requêtes N+1, absence de pagination, volumétrie",
    "be:fiabilite": "idempotence, tenue sous concurrence, cohérence transactionnelle",
    "be:donnees": "justesse des données — UTC, fuseau du tenant, montants entiers",
}

MARQUE_EMPREINTE = "<!-- qa:empreinte="


class QaError(Exception):
    """Erreur rendue proprement à l'appelant, avec son code de sortie.

    Le code n'est pas déduit du message : un `USAGE` dit « l'appel était
    fautif, corrige-le », un `FAIL` dit « l'appel était bon, l'environnement
    n'a pas suivi ». Un agent de campagne n'a pas les mêmes conduites dans les
    deux cas — réécrire son appel, ou signaler une panne — et deviner à partir
    d'une chaîne de caractères l'aurait trompé au premier message reformulé.
    """

    def __init__(self, message, code=FAIL):
        super().__init__(message)
        self.code = code


# --------------------------------------------------------------------------
# Appels externes — isolés ici pour que les tests puissent les remplacer.
# --------------------------------------------------------------------------

def run(args, **kw):
    kw.setdefault("capture_output", True)
    kw.setdefault("text", True)
    kw.setdefault("encoding", "utf-8")
    kw.setdefault("errors", "replace")
    return subprocess.run(args, **kw)


def gh(args, **kw):
    proc = run(["gh", *args], **kw)
    if proc.returncode != 0:
        raise QaError((proc.stderr or proc.stdout or "gh a échoué").strip())
    return proc.stdout


def gh_json(args, **kw):
    sortie = gh(args, **kw).strip()
    return json.loads(sortie) if sortie else None


def git(args, **kw):
    proc = run(["git", "-C", str(ROOT), *args], **kw)
    if proc.returncode != 0:
        raise QaError((proc.stderr or proc.stdout or "git a échoué").strip())
    return proc.stdout


# --------------------------------------------------------------------------
# Fonctions pures — le cœur testable.
# --------------------------------------------------------------------------

def empreinte(critere, module, url, cle=""):
    """L'identité d'un défaut, stable d'une campagne à l'autre.

    Volontairement **sans le titre** : un agent reformule son titre à chaque
    passage, et une empreinte qui en dépendrait rouvrirait le même bug
    indéfiniment. Ce qui identifie un défaut, c'est le critère enfreint et
    l'endroit où il l'est. `cle` sert quand deux défauts du même critère
    cohabitent sur une même page — sans elle, le second serait pris pour le
    premier et perdu.
    """
    graine = "|".join((critere.strip().lower(), module.strip().lower(),
                       normaliser_url(url), cle.strip().lower()))
    return hashlib.sha1(graine.encode("utf-8")).hexdigest()[:12]


def normaliser_url(url):
    """`/reserver/creneaux?jour=3` et `/reserver/creneaux` désignent le même
    endroit : la chaîne de requête et la barre finale ne font pas partie de
    l'identité du défaut. Les segments dynamiques déjà substitués par un
    identifiant sont ramenés à `:id`, sans quoi chaque exécution du jeu d'essai
    produirait une empreinte neuve.
    """
    url = (url or "").strip().split("?")[0].split("#")[0]
    url = re.sub(r"/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                 "/:id", url, flags=re.I)
    url = re.sub(r"/\d+(?=/|$)", "/:id", url)
    return url.rstrip("/").lower() or "/"


def slug(texte, longueur=48):
    texte = unicodedata.normalize("NFKD", texte or "")
    texte = texte.encode("ascii", "ignore").decode("ascii").lower()
    texte = re.sub(r"[^a-z0-9]+", "-", texte).strip("-")
    return (texte[:longueur].rstrip("-") or "constat")


def labels_for(gravite, module, workstream):
    priorite, _ = GRAVITES[gravite]
    return ["type:bug", "nature:projet", WORKSTREAMS[workstream],
            f"mod:{module}", priorite]


def valider(critere, module, workstream, gravite):
    """Tout est refusé **avant** l'appel à `gh`. Un ticket à moitié créé, puis
    corrigé après coup, laisse une notification fausse et une carte de Project
    au mauvais endroit : mieux vaut ne pas l'ouvrir.
    """
    if critere not in CRITERES:
        raise QaError(f"critère inconnu : {critere}\n"
                      f"attendus : {', '.join(sorted(CRITERES))}", USAGE)
    if module not in MODULES:
        raise QaError(f"module inconnu : {module}\n"
                      f"attendus : {', '.join(MODULES)}", USAGE)
    if workstream not in WORKSTREAMS:
        raise QaError(f"workstream inconnu : {workstream}\n"
                      f"attendus : {', '.join(WORKSTREAMS)}", USAGE)
    if gravite not in GRAVITES:
        raise QaError(f"gravité inconnue : {gravite}\n"
                      f"attendues : {', '.join(GRAVITES)}", USAGE)


def parse_capture(brut):
    """`chemin/vers/capture.png:Ce qu'il faut y regarder`.

    Le `:` d'un chemin Windows (`D:/…`) ne doit pas être pris pour le séparateur
    de légende : on coupe sur le **dernier** `:` qui suit une extension d'image.
    """
    match = re.match(r"^(?P<chemin>.+?\.(?:png|jpg|jpeg|webp))(?::(?P<legende>.*))?$",
                     brut, flags=re.I)
    if not match:
        raise QaError(f"capture illisible : {brut}\n"
                      "attendu : chemin/vers/image.png[:légende]", USAGE)
    chemin = Path(match.group("chemin")).expanduser()
    legende = (match.group("legende") or "").strip()
    return chemin, legende


def corps(constat, captures, doublon_ferme=None):
    """Le corps d'un ticket de bug — ce qu'un agent de correction doit lire pour
    travailler **sans revenir vers l'humain**. D'où l'ordre : l'attendu avant le
    constaté (sinon on lit un symptôme sans référence), la preuve avant la
    reproduction (sinon on refait le travail de la campagne).
    """
    libelle = CRITERES[constat["critere"]]
    priorite, sens = GRAVITES[constat["gravite"]]
    lignes = [
        "## Ce qui est attendu", "", constat["attendu"], "",
        "## Ce qui est constaté", "", constat["constate"], "",
    ]

    if constat.get("mesure"):
        lignes += ["## Mesure", "", constat["mesure"], ""]

    lignes += ["## Preuve", "", "```", constat["preuve"].rstrip(), "```", ""]

    lignes += ["## Preuve visuelle", ""]
    if captures:
        for url, legende in captures:
            lignes.append(f"![{legende or 'capture de la campagne de QA'}]({url})")
            if legende:
                lignes.append(f"*{legende}*")
            lignes.append("")
    else:
        lignes += [f"_Aucune capture — {constat['sans_capture']}_", ""]

    if constat.get("reproduire"):
        lignes += ["## Comment reproduire", "", constat["reproduire"], ""]

    lignes += [
        "## Critère enfreint", "",
        f"`{constat['critere']}` — {libelle}.",
        f"Gravité **{constat['gravite']}** ({sens}) → `{priorite}`.",
        "",
        "Grille de référence : [.claude/skills/qa/SKILL.md](.claude/skills/qa/SKILL.md).",
        "",
    ]

    if doublon_ferme:
        lignes += [
            "## Régression", "",
            f"Ce défaut avait déjà été corrigé en #{doublon_ferme} — même "
            "empreinte, ticket fermé. Reprendre d'abord ce qui y avait été fait.",
            "",
        ]

    lignes += [
        "---", "",
        f"Campagne `{constat['campagne']}` · relevé le {constat['date']} · "
        f"endroit `{constat['url']}`",
        "",
        f"{MARQUE_EMPREINTE}{constat['empreinte']} -->",
    ]
    return "\n".join(lignes)


def extraire_empreinte(corps_issue):
    match = re.search(re.escape(MARQUE_EMPREINTE) + r"([0-9a-f]{6,40})", corps_issue or "")
    return match.group(1) if match else None


def campagne_du_jour(suffixe=1):
    return f"{datetime.now(timezone.utc):%Y%m%d}-{suffixe}"


# --------------------------------------------------------------------------
# Le jalon
# --------------------------------------------------------------------------

def milestones():
    """Tous les jalons, **fermés compris** — et sans `--jq`.

    Deux pièges tenus ici. `state=all` : l'API ne rend que les jalons ouverts
    par défaut, et un « Bug & correction » fermé une fois le stock écoulé ferait
    croire à `ensure_milestone()` qu'il faut le recréer — GitHub refuse alors le
    titre en double (422) et la campagne entière sort en échec. Pas de `--jq`
    non plus : combiné à `--paginate`, gh applique le filtre page par page et
    émet un tableau JSON *par page*, que `json.loads` ne sait pas relire.
    """
    jalons = gh_json(["api", f"repos/{REPO}/milestones", "--paginate",
                      "-X", "GET", "-f", "state=all"]) or []
    return [{"number": j["number"], "title": j["title"], "state": j["state"]}
            for j in jalons]


def ensure_milestone(verbeux=True):
    """Idempotent : deux campagnes lancées le même jour ne créent qu'un jalon.

    **Sans échéance, délibérément.** `current_milestone()` de `tracking.py`
    retient le premier jalon ouvert dont l'échéance n'est pas passée : donner
    une date à « Bug & correction » le ferait rafler tous les `/ticket-new`
    suivants, qui sortiraient du sprint en cours sans que personne ne le
    remarque.
    """
    for jalon in milestones():
        if jalon["title"].strip().lower() != JALON.strip().lower():
            continue
        # Un jalon fermé n'accueille plus de ticket : le rouvrir vaut mieux que
        # d'en créer un homonyme, que GitHub refuserait de toute façon.
        if jalon["state"].lower() == "closed":
            gh(["api", f"repos/{REPO}/milestones/{jalon['number']}",
                "--method", "PATCH", "-f", "state=open", "--silent"])
            if verbeux:
                print(f"jalon « {jalon['title']} » rouvert (#{jalon['number']})")
            return jalon["number"]
        if verbeux:
            print(f"jalon « {jalon['title']} » déjà là (#{jalon['number']})")
        return jalon["number"]
    cree = gh_json(["api", f"repos/{REPO}/milestones", "--method", "POST",
                    "-f", f"title={JALON}",
                    "-f", "description=Anomalies relevées par les campagnes de QA "
                          "(/qa). Sans échéance : ce jalon ne doit pas se "
                          "substituer au sprint en cours dans tracking.py.",
                    "--jq", "{number, title}"])
    if verbeux:
        print(f"jalon « {cree['title']} » créé (#{cree['number']})")
    return cree["number"]


# --------------------------------------------------------------------------
# Les captures
# --------------------------------------------------------------------------

def chemin_capture(campagne, marque, rang, fichier):
    """L'emplacement d'une capture sur la branche d'images. Le nom vient de
    l'**empreinte**, pas du titre : le même défaut retrouvé plus tard écrase sa
    capture au lieu d'en accumuler une par campagne.
    """
    return (f"docs/qa/captures/{campagne}/{marque}-{rang}"
            f"{Path(fichier).suffix.lower()}")


def url_capture(campagne, marque, rang, fichier):
    return (f"https://raw.githubusercontent.com/{REPO}/{BRANCHE_CAPTURES}/"
            f"{chemin_capture(campagne, marque, rang, fichier)}")


def verifier_captures(fichiers):
    """Les captures existent-elles, et tiennent-elles dans la limite ?

    Séparé de `pousser_captures` pour que `--dry-run` exerce la **même** garde :
    un essai à blanc qui accepterait un chemin fautif ne dirait rien de l'appel
    réel — et c'est précisément ce qu'on vient vérifier.

    Chaque chemin est **résolu** au passage. `Path.is_file()` part du répertoire
    courant du processus, `git -C ROOT` part de la racine du dépôt : un chemin
    relatif donné depuis un sous-dossier franchirait la garde ici pour échouer
    plus bas, sur un message de plomberie git que personne ne sait lire.
    """
    verifies = []
    for chemin, legende in fichiers:
        chemin = chemin.resolve()
        if not chemin.is_file():
            raise QaError(f"capture introuvable : {chemin}")
        taille = chemin.stat().st_size
        if taille > TAILLE_MAX_CAPTURE:
            raise QaError(f"capture trop lourde ({taille // 1024} Ko > "
                          f"{TAILLE_MAX_CAPTURE // 1024} Ko) : {chemin}\n"
                          "réduire la capture — la branche d'images n'est pas "
                          "une archive de captures 4K")
        verifies.append((chemin, legende))
    return verifies


def pousser_captures(fichiers, campagne, marque):
    """Dépose les captures sur `qa-captures` et rend leurs URL brutes.

    Écrit en plomberie : `hash-object` pour les octets, un index temporaire pour
    l'arbre, `commit-tree` pour le commit, puis un push direct du SHA vers la
    référence distante. Aucun `checkout`, aucun `worktree add` — la branche ne
    se matérialise jamais sur le disque, et le premier commit est **orphelin** :
    elle ne porte que des images, jamais l'historique du produit.
    """
    if not fichiers:
        return []

    entrees, resultats = [], []
    for rang, (chemin, legende) in enumerate(verifier_captures(fichiers), start=1):
        cible = chemin_capture(campagne, marque, rang, chemin)
        blob = git(["hash-object", "-w", "--", str(chemin)]).strip()
        entrees.append((blob, cible))
        resultats.append((url_capture(campagne, marque, rang, chemin), legende))

    # La branche peut ne pas exister : la première campagne l'inaugure.
    parent = None
    sonde = run(["git", "-C", str(ROOT), "fetch", "origin",
                 f"{BRANCHE_CAPTURES}:refs/qa-captures-base"])
    if sonde.returncode == 0:
        parent = git(["rev-parse", "refs/qa-captures-base"]).strip()

    with tempfile.TemporaryDirectory() as bac:
        index = str(Path(bac) / "index")
        env = dict(os.environ, GIT_INDEX_FILE=index)
        if parent:
            git(["read-tree", f"{parent}^{{tree}}"], env=env)
        else:
            git(["read-tree", "--empty"], env=env)
        for blob, cible in entrees:
            git(["update-index", "--add", "--cacheinfo", f"100644,{blob},{cible}"],
                env=env)
        arbre = git(["write-tree"], env=env).strip()

    message = (f"chore(qa): captures de la campagne {campagne} ({marque})\n\n"
               "Branche d'images des tickets du jalon « Bug & correction ».\n"
               "Elle ne merge jamais et ne porte aucun code.\n")
    args = ["commit-tree", arbre]
    if parent:
        args += ["-p", parent]
    commit = git(args + ["-m", message]).strip()
    git(["push", "origin", f"{commit}:refs/heads/{BRANCHE_CAPTURES}"])
    run(["git", "-C", str(ROOT), "update-ref", "-d", "refs/qa-captures-base"])
    return resultats


# --------------------------------------------------------------------------
# Les tickets
# --------------------------------------------------------------------------

def issues_du_jalon(etat="all"):
    return gh_json(["issue", "list", "--repo", REPO, "--milestone", JALON,
                    "--state", etat, "--limit", "500",
                    "--json", "number,title,state,body,url,labels"]) or []


def chercher_doublon(marque, connues=None):
    """Rend `(numéro, état, url)` du ticket qui porte déjà cette empreinte.

    Un ticket **ouvert** l'emporte toujours sur un ticket fermé de la même
    empreinte, et ce n'est pas un détail de tri : dès qu'une régression a été
    ouverte, deux issues portent la même marque — l'ancienne, corrigée, et la
    nouvelle. Prendre la première venue ferait rouvrir une régression de la
    régression à chaque campagne, c'est-à-dire le doublon que tout ce dispositif
    existe pour éviter.
    """
    trouves = [i for i in (connues if connues is not None else issues_du_jalon())
               if extraire_empreinte(i.get("body")) == marque]
    if not trouves:
        return None, None, None
    issue = next((i for i in trouves if i["state"].lower() == "open"), trouves[0])
    return issue["number"], issue["state"].lower(), issue.get("url")


def poser_la_carte(numero, module, workstream, priorite):
    """Ajoute l'issue au GitHub Project. **Jamais bloquant.**

    Le workflow `project-automation.yml` est censé s'en charger, mais il exige
    le secret `PROJECT_TOKEN`, absent du dépôt : sans ce rappel, une campagne
    remplirait le jalon et laisserait le board vide — l'anomalie n'apparaîtrait
    dans aucune vue de suivi. `tracking.py` fait déjà exactement cela pour les
    tickets de traçabilité, par le même script.

    Un ticket ouvert vaut mieux qu'un ticket parfait : si la carte échoue —
    jeton sans le scope `project`, réseau —, on le dit et on continue.
    """
    proc = run([sys.executable, str(ROOT / "scripts" / "project_status.py"),
                str(numero), "Ready",
                "--field", f"Workstream={workstream}",
                "--field", f"Module={module}",
                "--field", f"Priority={priorite}"])
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        print(f"qa_bugs : carte de Project non posée pour #{numero}"
              f"{' — ' + detail[-1] if detail else ''}", file=sys.stderr)
    return proc.returncode == 0


def cmd_open(args):
    valider(args.critere, args.module, args.workstream, args.gravite)

    if not args.capture and not args.sans_capture:
        raise QaError(
            "aucune capture, et aucune raison de ne pas en avoir.\n"
            "Un constat de QA sans image ne se relit pas six jours plus tard :\n"
            "  --capture <chemin.png>[:légende]   (répétable)\n"
            "  --sans-capture \"<pourquoi il n'y en a pas>\"", USAGE)

    fichiers = [parse_capture(brut) for brut in (args.capture or [])]
    marque = empreinte(args.critere, args.module, args.url, args.cle or "")
    campagne = args.campagne or campagne_du_jour()

    constat = {
        "titre": args.titre.strip(),
        "critere": args.critere, "module": args.module,
        "workstream": args.workstream, "gravite": args.gravite,
        "url": args.url.strip(), "attendu": args.attendu.strip(),
        "constate": args.constate.strip(), "preuve": args.preuve.strip(),
        "mesure": (args.mesure or "").strip(),
        "reproduire": (args.reproduire or "").strip(),
        "sans_capture": (args.sans_capture or "").strip(),
        "campagne": campagne, "empreinte": marque,
        "date": f"{datetime.now(timezone.utc):%d/%m/%Y}",
    }
    etiquettes = labels_for(args.gravite, args.module, args.workstream)

    if args.dry_run:
        # Mêmes gardes que l'appel réel : un essai à blanc qui accepterait un
        # chemin fautif ou une capture de cinq mégaoctets rendrait un ticket
        # parfait, et l'appel réel échouerait sur chaque constat derrière lui.
        #
        # Les URL montrées sont celles que les captures **auront** : un essai à
        # blanc qui rendrait des chemins locaux ne dirait rien de ce que le
        # relecteur verra, et c'est précisément ce qu'on vient vérifier.
        fichiers = verifier_captures(fichiers)
        futures = [(url_capture(campagne, marque, rang, chemin), legende)
                   for rang, (chemin, legende) in enumerate(fichiers, start=1)]
        print(json.dumps({
            "titre": constat["titre"], "labels": etiquettes, "milestone": JALON,
            "empreinte": marque, "campagne": campagne,
            "captures": [str(c) for c, _ in fichiers],
            "corps": corps(constat, futures),
        }, ensure_ascii=False, indent=2))
        return OK

    ensure_milestone(verbeux=False)
    existant, etat, url = chercher_doublon(marque)

    if existant and etat == "open":
        gh(["issue", "comment", str(existant), "--repo", REPO, "--body",
            f"Retrouvé par la campagne `{campagne}` du {constat['date']} — "
            f"toujours présent sur `{constat['url']}`.\n\n"
            f"Aucun nouveau ticket ouvert : même empreinte `{marque}`."])
        print(json.dumps({"issue": existant, "url": url, "doublon": True,
                          "empreinte": marque}, ensure_ascii=False))
        return OK

    captures = pousser_captures(fichiers, campagne, marque)
    body = corps(constat, captures, doublon_ferme=existant if etat == "closed" else None)

    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False,
                                     encoding="utf-8") as fichier:
        fichier.write(body)
        chemin_corps = fichier.name
    try:
        cree = gh(["issue", "create", "--repo", REPO,
                   "--title", constat["titre"], "--body-file", chemin_corps,
                   "--milestone", JALON,
                   *sum((["--label", e] for e in etiquettes), [])]).strip()
    finally:
        os.unlink(chemin_corps)

    numero = int(cree.rstrip("/").rsplit("/", 1)[-1])
    sur_le_board = poser_la_carte(numero, args.module, args.workstream,
                                  GRAVITES[args.gravite][0])
    print(json.dumps({"issue": numero, "url": cree.splitlines()[-1].strip(),
                      "labels": etiquettes, "milestone": JALON,
                      "empreinte": marque, "campagne": campagne,
                      "captures": [u for u, _ in captures],
                      "project": sur_le_board,
                      "regression_de": existant if etat == "closed" else None},
                     ensure_ascii=False))
    return OK


def cmd_list(args):
    issues = issues_du_jalon(args.state)
    if args.json:
        print(json.dumps([{**i, "empreinte": extraire_empreinte(i.get("body"))}
                          for i in issues], ensure_ascii=False, indent=2))
        return OK
    if not issues:
        print(f"jalon « {JALON} » : aucune anomalie.")
        return OK
    print(f"Jalon « {JALON} » · {len(issues)} anomalie(s)")
    for issue in issues:
        etat = "ouvert" if issue["state"].lower() == "open" else "fermé"
        print(f"  #{issue['number']:<5} [{etat:<6}] {issue['title']}")
    return OK


def cmd_report(args):
    """Le tableau que `/qa` publie en fin de campagne. Il ne raconte pas ce que
    la campagne a fait : il dit ce qu'elle a **laissé à corriger**.
    """
    issues = [i for i in issues_du_jalon("open")]
    if args.campagne:
        issues = [i for i in issues if f"Campagne `{args.campagne}`" in (i.get("body") or "")]

    par_gravite = {"P0": [], "P1": [], "P2": [], "?": []}
    for issue in issues:
        noms = {e["name"] for e in (issue.get("labels") or [])}
        rang = next((p for p in ("P0", "P1", "P2") if p in noms), "?")
        par_gravite[rang].append(issue)

    titre = f"Campagne `{args.campagne}`" if args.campagne else f"Jalon « {JALON} »"
    print(f"### {titre} — {len(issues)} anomalie(s) ouverte(s)\n")
    if not issues:
        print("Aucune anomalie ouverte. Rien à corriger.")
        return OK
    print("| Priorité | Ticket | Constat |")
    print("|---|---|---|")
    for rang in ("P0", "P1", "P2", "?"):
        for issue in par_gravite[rang]:
            print(f"| `{rang}` | #{issue['number']} | {issue['title']} |")
    print(f"\nDérouler les corrections : `/milestone \"{JALON}\"`.")
    return OK


def cmd_ensure_milestone(args):
    ensure_milestone()
    return OK


# --------------------------------------------------------------------------

def build_parser():
    parser = argparse.ArgumentParser(
        prog="qa_bugs.py",
        description="Point d'écriture des tickets d'anomalie du jalon "
                    f"« {JALON} ».")
    sous = parser.add_subparsers(dest="commande", required=True)

    sous.add_parser("ensure-milestone",
                    help="créer le jalon s'il n'existe pas (idempotent)")

    ouvrir = sous.add_parser("open", help="ouvrir le ticket d'un constat de QA")
    ouvrir.add_argument("--titre", required=True,
                        help="ce qui ne va pas, en une phrase — pas « bug sur la page »")
    ouvrir.add_argument("--critere", required=True,
                        help=f"un critère de la grille : {', '.join(sorted(CRITERES))}")
    ouvrir.add_argument("--module", required=True, choices=MODULES)
    ouvrir.add_argument("--workstream", required=True, choices=sorted(WORKSTREAMS))
    ouvrir.add_argument("--gravite", required=True, choices=sorted(GRAVITES))
    ouvrir.add_argument("--url", required=True,
                        help="la page ou la route où le défaut se voit")
    ouvrir.add_argument("--attendu", required=True)
    ouvrir.add_argument("--constate", required=True)
    ouvrir.add_argument("--preuve", required=True,
                        help="verbatim : appel HTTP et réponse, message de console, mesure")
    ouvrir.add_argument("--mesure", help="la valeur relevée et le seuil, si le critère se chiffre")
    ouvrir.add_argument("--reproduire", help="les gestes, dans l'ordre")
    ouvrir.add_argument("--capture", action="append",
                        help="chemin.png[:légende] — répétable")
    ouvrir.add_argument("--sans-capture", dest="sans_capture",
                        help="la raison pour laquelle ce constat n'a pas d'image")
    ouvrir.add_argument("--cle", help="discrimine deux défauts du même critère au même endroit")
    ouvrir.add_argument("--campagne", help="identifiant de campagne (défaut : AAAAMMJJ-1)")
    ouvrir.add_argument("--dry-run", action="store_true",
                        help="montrer le ticket sans l'ouvrir")

    lister = sous.add_parser("list", help="les anomalies du jalon")
    lister.add_argument("--state", default="open", choices=("open", "closed", "all"))
    lister.add_argument("--json", action="store_true")

    rapport = sous.add_parser("report", help="le tableau de fin de campagne")
    rapport.add_argument("--campagne")

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    commandes = {"ensure-milestone": cmd_ensure_milestone, "open": cmd_open,
                 "list": cmd_list, "report": cmd_report}
    try:
        return commandes[args.commande](args)
    except QaError as exc:
        print(f"qa_bugs : {exc}", file=sys.stderr)
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
