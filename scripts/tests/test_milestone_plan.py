#!/usr/bin/env python3
"""Tests du planificateur de jalon — `scripts/milestone_plan.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Ce qui est surveillé ici tient en une phrase : **le plan ne doit jamais dispatcher
un ticket sur un `develop` qui ne porte pas le travail dont il dépend** (#155).

Le défaut d'origine venait de deux mécanismes corrects pris séparément. `qualify()`
écarte du plan une issue déjà couverte par une PR ouverte — on ne relance pas un
agent sur un ticket en vol. `plan_waves()` calcule les tickets prêts par
`prereqs[n] & remaining` — un prérequis absent de `remaining` est réputé
satisfait. Une issue écartée n'étant plus dans `remaining`, elle cessait de
bloquer ses dépendants, qui partaient sur une base amputée.

La correction repose sur une distinction que ces tests figent, parce qu'elle n'a
rien d'évident à la lecture :

  * une issue **écartée** est une issue **ouverte** que le plan refuse de
    dispatcher — son travail est en vol, en attente ou pas commencé, jamais sur
    `develop`. Elle retient ses dépendants ;
  * une issue **fermée** ne passe même pas par `qualify()` : `fetch_issues` ne lit
    que les ouvertes. Elle n'a aucune arête, et c'est à raison qu'elle libère ses
    dépendants — c'est le seul cas où le travail est réellement intégré.

Une régression ici ne casserait rien de visible : le plan resterait vert, les
agents partiraient, et le défaut se paierait au merge suivant ou en recette.
C'est exactement le mode de défaillance silencieux que #155 dénonçait.

Aucune dépendance : `unittest` de la bibliothèque standard, comme le reste de
`scripts/tests`. Le dépôt n'a pas de gestion de paquets Python.
"""
import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py` qui changeraient la façon dont
# les scripts eux-mêmes s'importent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import milestone_plan  # noqa: E402 — l'insertion de chemin ci-dessus doit la précéder


FULL = ("ws:devops", "mod:infra", "type:chore", "P1", "nature:projet")


def issue(number, title=None, body="", labels=FULL, assignees=()):
    """Une issue telle que `gh issue list --json` en rend."""
    return {
        "number": number,
        "title": title or f"Issue {number}",
        "body": body,
        "labels": [{"name": name} for name in labels],
        "assignees": [{"login": login} for login in assignees],
        "url": f"https://github.com/TMap-Works/spa-booking/issues/{number}",
    }


def pull(number, closes, mentions=()):
    """Une PR ouverte qui **ferme** `closes`, et qui en **mentionne** d'autres.

    Les deux champs ne disent pas la même chose, et c'est tout l'objet de #308 :
    `closingIssuesReferences` est le lien que GitHub résout à partir des
    mots-clés de fermeture, le corps n'est que de la prose. Une PR bien écrite
    cite ses voisines pour justifier sa frontière de périmètre — les compter
    pour occupées gèle le jalon.
    """
    cites = " ".join(f"voir #{n}" for n in mentions)
    return {
        "number": number,
        "body": f"Closes #{closes}\n\n{cites}",
        "headRefName": f"chore/{closes}-un-travail",
        "closingIssuesReferences": [
            {"number": closes,
             "repository": {"name": "spa-booking", "owner": {"login": "TMap-Works"}}}
        ],
    }


class FakeHub:
    """Double de `milestone_plan.gh_json` — les trois seuls appels du planificateur.

    Une commande qu'aucune règle ne couvre lève : un appel réseau inattendu doit
    faire rougir le test, pas partir vers GitHub.
    """

    def __init__(self, issues, prs=(), closed=0):
        self.issues = list(issues)
        self.prs = list(prs)
        self.milestone = {
            "title": "S1 — Fondations", "number": 1, "state": "open",
            "due_on": "2999-01-01T00:00:00Z",
            "open_issues": len(self.issues), "closed_issues": closed,
        }

    def __call__(self, args):
        if args[0] == "api":
            return [self.milestone]
        if args[0] == "issue":
            return self.issues
        if args[0] == "pr":
            return self.prs
        raise AssertionError("appel gh inattendu : " + " ".join(args))


def run_plan(hub, argv=(), rules=None):
    """Le planificateur de bout en bout, sans réseau ni horloge. Rend (code, sortie).

    `rules=None` laisse lire le vrai `.claude/milestone-rules.json` : c'est ce qui
    permet de rejouer le cas réel du jalon S1 sans le recopier ici.
    """
    buffer = io.StringIO()
    with contextlib.ExitStack() as stack:
        stack.enter_context(mock.patch.object(milestone_plan, "gh_json", hub))
        stack.enter_context(mock.patch.object(milestone_plan, "whoami", lambda: "moi"))
        stack.enter_context(mock.patch.object(sys, "argv", ["milestone_plan.py", *argv]))
        if rules is not None:
            stack.enter_context(
                mock.patch.object(milestone_plan, "load_rules", lambda: rules))
        stack.enter_context(contextlib.redirect_stdout(buffer))
        code = milestone_plan.main()
    return code, buffer.getvalue()


def plan_of(hub, rules=None):
    """Le plan en JSON, tel que `/milestone` le consomme."""
    code, out = run_plan(hub, ["--json"], rules)
    return code, json.loads(out)


def scheduled(plan):
    """Les numéros que le plan propose réellement de dispatcher."""
    return {node["number"] for wave in plan["waves"] for node in wave["issues"]}


def retenues(plan):
    return {item["number"]: item for item in plan["withheld"]}


def ecartees(plan):
    return {item["number"]: item for item in plan["excluded"]}


# Deux ressources disjointes : ce qui sépare #10 et #20 dans ces tests ne peut
# donc jamais être une collision d'empreinte, seulement la dépendance.
DEUX = {"resources": {"10": ["infra/terraform/modules/a"],
                      "20": ["infra/terraform/modules/b"],
                      "30": ["infra/terraform/modules/c"]},
        "depends": {"20": [10]},
        "why": {"20": "le module b se pose dans le module a"}}


class PrerequisEnPrOuverte(unittest.TestCase):
    """Le cas nommé par #155 : la PR est ouverte, donc le travail n'est nulle part."""

    def setUp(self):
        self.hub = FakeHub([issue(10), issue(20)], [pull(157, closes=10)])

    def test_le_dependant_n_est_pas_dispatche(self):
        code, plan = plan_of(self.hub, DEUX)
        self.assertEqual(code, milestone_plan.OK)
        self.assertNotIn(20, scheduled(plan))

    def test_le_prerequis_est_ecarte_pas_planifie(self):
        _, plan = plan_of(self.hub, DEUX)
        self.assertNotIn(10, scheduled(plan))
        self.assertIn("PR #157", ecartees(plan)[10]["reason"])

    def test_le_plan_nomme_la_pr_qui_retient(self):
        _, plan = plan_of(self.hub, DEUX)
        held = retenues(plan)[20]["held_by"]
        self.assertEqual([h["number"] for h in held], [10])
        self.assertEqual(held[0]["pr"], 157)

    def test_la_rubrique_retenues_est_distincte_des_ecartees(self):
        _, out = run_plan(self.hub, rules=DEUX)
        self.assertIn("Retenues", out)
        self.assertIn("Écartées", out)
        retenues_bloc = out.split("Retenues")[1].split("Écartées")[0]
        self.assertIn("#20", retenues_bloc)
        self.assertIn("PR #157", retenues_bloc)

    def test_un_plan_entierement_retenu_reste_un_plan(self):
        """Zéro vague n'est pas une erreur : le jalon attend ses PR.

        `milestone_run.plan_json` échoue sur tout code de retour non nul. Rendre
        EMPTY ici ferait planter `open` et surtout `replan` en plein run, au moment
        précis où le jalon est en attente — la panne serait pire que le défaut.
        """
        code, plan = plan_of(self.hub, DEUX)
        self.assertEqual(code, milestone_plan.OK)
        self.assertEqual(scheduled(plan), set())
        self.assertEqual(set(retenues(plan)), {20})


class PrerequisFerme(unittest.TestCase):
    """Le seul cas où le travail est vraiment sur `develop`."""

    def test_un_prerequis_ferme_libere_son_dependant(self):
        # #10 est fermée : `fetch_issues` ne lit que les ouvertes, elle est donc
        # absente de la liste — elle n'atteint jamais `qualify()`.
        code, plan = plan_of(FakeHub([issue(20)], closed=1), DEUX)
        self.assertEqual(code, milestone_plan.OK)
        self.assertIn(20, scheduled(plan))
        self.assertEqual(plan["withheld"], [])

    def test_aucune_arete_vers_une_issue_fermee(self):
        _, plan = plan_of(FakeHub([issue(20)], closed=1), DEUX)
        self.assertEqual([e for e in plan["edges"] if e["parent"] == 10], [])


class PrerequisEcartePourUneAutreRaison(unittest.TestCase):
    """Classement incomplet, quelqu'un d'autre dessus : le travail n'est pas là non plus."""

    def test_classement_incomplet_retient(self):
        boiteuse = issue(10, labels=("ws:devops", "mod:infra", "type:chore"))
        _, plan = plan_of(FakeHub([boiteuse, issue(20)]), DEUX)
        self.assertNotIn(20, scheduled(plan))
        self.assertIn("classement incomplet", retenues(plan)[20]["held_by"][0]["reason"])
        self.assertIsNone(retenues(plan)[20]["held_by"][0]["pr"])

    def test_assignee_a_quelqu_un_d_autre_retient(self):
        prise = issue(10, assignees=("une-autre-personne",))
        _, plan = plan_of(FakeHub([prise, issue(20)]), DEUX)
        self.assertNotIn(20, scheduled(plan))
        self.assertIn("assignée à", retenues(plan)[20]["held_by"][0]["reason"])

    def test_le_rendu_dit_laquelle_et_pourquoi(self):
        boiteuse = issue(10, labels=("ws:devops", "mod:infra", "type:chore"))
        _, out = run_plan(FakeHub([boiteuse, issue(20)]), rules=DEUX)
        bloc = out.split("Retenues")[1].split("Écartées")[0]
        self.assertIn("#20", bloc)
        self.assertIn("#10", bloc)
        self.assertIn("classement incomplet", bloc)


class RetenueTransitive(unittest.TestCase):
    """Ce qu'un retenu bloque est retenu à son tour, jusqu'au bout de la chaîne."""

    RULES = dict(DEUX, depends={"20": [10], "30": [20]})

    def test_la_chaine_entiere_est_retenue(self):
        hub = FakeHub([issue(10), issue(20), issue(30)], [pull(157, closes=10)])
        _, plan = plan_of(hub, self.RULES)
        self.assertEqual(scheduled(plan), set())
        self.assertEqual(set(retenues(plan)), {20, 30})

    def test_la_cause_racine_est_remontee(self):
        hub = FakeHub([issue(10), issue(20), issue(30)], [pull(157, closes=10)])
        _, plan = plan_of(hub, self.RULES)
        self.assertEqual([h["number"] for h in retenues(plan)[30]["held_by"]], [10])

    def test_la_chaine_repart_quand_le_prerequis_est_ferme(self):
        # #10 fermée : plus de PR ouverte, plus de retenue, tout se replanifie.
        hub = FakeHub([issue(20), issue(30)], closed=1)
        _, plan = plan_of(hub, self.RULES)
        self.assertEqual(scheduled(plan), {20, 30})
        self.assertEqual(plan["withheld"], [])


class CasReelS1(unittest.TestCase):
    """#16 « Déployer l'environnement dev », telle que le jalon S1 la pose.

    Les dépendances viennent du vrai `.claude/milestone-rules.json` — pas d'un
    décor : `"16": [11, 12, 13, 14, 15]`. Le scénario est celui de l'issue : #12 et
    #13 rendent des PR d'infrastructure, que `pr_gate.py` refuse de merger sans
    relecture humaine (périmètre sensible sous `SPA_UNATTENDED`). Elles resteront
    donc ouvertes un moment, et #16 ne doit pas partir pendant ce temps.
    """

    def setUp(self):
        titres = {
            11: "Module Terraform network — VPC, sous-réseaux, NAT",
            12: "Modules Terraform database et cache",
            13: "Module Terraform ecs-service",
            14: "Rôle OIDC GitHub Actions vers AWS",
            15: "Image Docker et pipeline de build",
            16: "Déployer l'environnement dev de bout en bout",
        }
        self.hub = FakeHub(
            [issue(n, title=t, labels=("ws:devops", "mod:infra", "type:chore",
                                       "P0", "nature:projet"))
             for n, t in titres.items()],
            [pull(157, closes=12), pull(158, closes=13)])

    def test_16_n_est_pas_proposee(self):
        code, plan = plan_of(self.hub)
        self.assertEqual(code, milestone_plan.OK)
        self.assertNotIn(16, scheduled(plan))

    def test_le_plan_dit_quelles_pr_la_retiennent(self):
        _, plan = plan_of(self.hub)
        held = retenues(plan)[16]["held_by"]
        self.assertEqual({h["number"] for h in held}, {12, 13})
        self.assertEqual({h["pr"] for h in held}, {157, 158})

    def test_les_prerequis_libres_avancent_quand_meme(self):
        """La retenue est ciblée : elle ne gèle pas le reste du jalon."""
        _, plan = plan_of(self.hub)
        self.assertEqual(scheduled(plan), {11, 14, 15})

    def test_16_repart_une_fois_les_pr_mergees(self):
        # Les PR mergées, #11 à #15 fermées : elles disparaissent des issues
        # ouvertes, et #16 redevient la seule chose à faire.
        _, plan = plan_of(FakeHub([self.hub.issues[-1]], closed=5))
        self.assertEqual(scheduled(plan), {16})
        self.assertEqual(plan["withheld"], [])


class PrerequisHeuristique(unittest.TestCase):
    """La retenue doit valoir aussi pour les arêtes déduites, pas seulement figées.

    L'heuristique produit le gros du graphe — « l'écran consomme l'API du même
    module », « le schéma précède le code », « le test suit ce qu'il vérifie ».
    Si elle ne regarde que les issues planifiables, une écartée n'y apparaît
    jamais comme parent, et son dépendant part quand même : le défaut de #155
    intact, sur la source d'arêtes la plus fréquente.
    """

    def test_l_ecran_ne_part_pas_si_l_api_du_module_est_en_pr(self):
        hub = FakeHub(
            [issue(10, title="API catalogue",
                   labels=("ws:backend", "mod:catalog", "type:feat", "P1",
                           "nature:projet")),
             issue(20, title="Écran catalogue",
                   labels=("ws:frontend", "mod:catalog", "type:feat", "P1",
                           "nature:projet"))],
            [pull(157, closes=10)])
        _, plan = plan_of(hub, {})
        self.assertNotIn(20, scheduled(plan))
        self.assertEqual([h["number"] for h in retenues(plan)[20]["held_by"]], [10])
        self.assertEqual(retenues(plan)[20]["held_by"][0]["pr"], 157)

    def test_le_test_ne_part_pas_si_ce_qu_il_verifie_est_en_pr(self):
        hub = FakeHub(
            [issue(10, title="API rendez-vous",
                   labels=("ws:backend", "mod:appointments", "type:feat", "P1",
                           "nature:projet")),
             issue(20, title="Tests du moteur",
                   labels=("ws:qa", "mod:appointments", "type:test", "P1",
                           "nature:projet"))],
            [pull(157, closes=10)])
        _, plan = plan_of(hub, {})
        self.assertNotIn(20, scheduled(plan))


class EcarteeQuiNeSeraJamaisFaite(unittest.TestCase):
    """Hors périmètre, traçabilité, épique : les retenir gèlerait le jalon à vie.

    Ces trois-là ne sont pas « en vol » : aucun merge ne les fermera jamais. Les
    traiter comme un prérequis non satisfait bloquerait leurs dépendants sans
    aucune issue de secours — le plan ne pourrait plus jamais repartir.
    """

    RULES = {"resources": {"10": ["a"], "20": ["b"]}, "depends": {"20": [10]}}

    def test_un_prerequis_post_mvp_ne_retient_pas(self):
        hors = issue(10, labels=("post-mvp", "ws:devops", "mod:infra", "type:chore", "P1"))
        _, plan = plan_of(FakeHub([hors, issue(20)]), self.RULES)
        self.assertIn(20, scheduled(plan))
        self.assertEqual(plan["withheld"], [])
        self.assertIn(10, ecartees(plan))

    def test_un_prerequis_epique_ne_retient_pas(self):
        epique = issue(10, labels=("type:epic", "ws:devops", "mod:infra", "P1"))
        _, plan = plan_of(FakeHub([epique, issue(20)]), self.RULES)
        self.assertIn(20, scheduled(plan))
        self.assertEqual(plan["withheld"], [])

    def test_un_ticket_de_tracabilite_ne_retient_pas(self):
        trace = issue(10, labels=("tracking", "ws:devops", "mod:infra", "type:chore", "P1"))
        _, plan = plan_of(FakeHub([trace, issue(20)]), self.RULES)
        self.assertIn(20, scheduled(plan))
        self.assertEqual(plan["withheld"], [])

    def test_un_prerequis_d_outillage_ne_retient_pas(self):
        """Le seul des quatre dont le travail sera peut-être fait — mais ailleurs.

        Un ticket d'outillage attend une session humaine, que rien n'oblige à
        venir avant le sprint. Le tenir pour un prérequis non satisfait
        suspendrait le produit à un chantier dont le run ne sait rien, et pour
        une durée que personne ne contrôle.
        """
        outil = issue(10, labels=("ws:devops", "mod:infra", "type:chore", "P1",
                                  "nature:outillage"))
        _, plan = plan_of(FakeHub([outil, issue(20)]), self.RULES)
        self.assertIn(20, scheduled(plan))
        self.assertEqual(plan["withheld"], [])
        self.assertIn("outillage", ecartees(plan)[10]["reason"])


class OutillageHorsDuRun(unittest.TestCase):
    """Le run ne déroule que le produit — et ne devine jamais de quel côté ranger.

    Un agent de vague qui réécrit `milestone_run.py` modifie l'orchestrateur qui
    l'exécute, pendant qu'il l'exécute. C'est la raison d'être de l'exclusion :
    ces chantiers-là se prennent à la main, une session à la fois.
    """

    def outil(self, number, **kw):
        return issue(number, labels=("ws:devops", "mod:infra", "type:chore",
                                     "P1", "nature:outillage"), **kw)

    def test_un_ticket_d_outillage_n_est_jamais_dispatche(self):
        _, plan = plan_of(FakeHub([self.outil(10), issue(20)]), DEUX)
        self.assertNotIn(10, scheduled(plan))
        self.assertIn(20, scheduled(plan))

    def test_un_jalon_qui_n_a_plus_que_de_l_outillage_n_a_rien_a_derouler(self):
        code, out = run_plan(FakeHub([self.outil(10), self.outil(20)]), rules=DEUX)
        self.assertEqual(code, milestone_plan.EMPTY)
        self.assertIn("outillage", out)

    def test_l_en_tete_compte_les_tickets_d_outillage(self):
        """Le chiffre est la liste des chantiers qui attendent un humain : le
        cacher ferait passer un jalon à moitié traité pour un jalon déroulé."""
        _, out = run_plan(FakeHub([self.outil(10), self.outil(30), issue(20)]),
                          rules=DEUX)
        self.assertIn("2 outillage", out.splitlines()[1])

    def test_sans_nature_l_issue_sort_en_classement_incomplet(self):
        """Ni dispatchée ni oubliée : rien n'autorise à choisir à sa place."""
        muette = issue(10, labels=("ws:devops", "mod:infra", "type:chore", "P1"))
        _, plan = plan_of(FakeHub([muette, issue(20)]), DEUX)
        self.assertNotIn(10, scheduled(plan))
        self.assertIn("nature", ecartees(plan)[10]["reason"])

    def test_sans_nature_l_issue_retient_ses_dependants(self):
        """Contrairement à l'outillage : un classement se corrige en une minute,
        et le dépendant repartira au plan suivant."""
        rules = {"resources": {"10": ["a"], "20": ["b"]}, "depends": {"20": [10]}}
        muette = issue(10, labels=("ws:devops", "mod:infra", "type:chore", "P1"))
        _, plan = plan_of(FakeHub([muette, issue(20)]), rules)
        self.assertNotIn(20, scheduled(plan))
        self.assertIn("classement incomplet", retenues(plan)[20]["held_by"][0]["reason"])


class Invariants(unittest.TestCase):
    """Ce qui doit rester vrai quel que soit le décor."""

    def test_une_issue_recevable_est_planifiee_ou_retenue_jamais_les_deux(self):
        hub = FakeHub([issue(10), issue(20), issue(30)],
                      [pull(157, closes=10)])
        rules = dict(DEUX, depends={"20": [10]})
        _, plan = plan_of(hub, rules)
        recevables = {20, 30}          # #10 est écartée, donc pas recevable
        self.assertEqual(scheduled(plan) | set(retenues(plan)), recevables)
        self.assertEqual(scheduled(plan) & set(retenues(plan)), set())

    def test_une_ecartee_n_est_jamais_retenue(self):
        """Les deux rubriques ne se recouvrent pas : écartée ≠ retenue."""
        hub = FakeHub([issue(10), issue(20)], [pull(157, closes=10)])
        _, plan = plan_of(hub, DEUX)
        self.assertEqual(set(ecartees(plan)) & set(retenues(plan)), set())

    def test_include_busy_rend_le_prerequis_au_plan(self):
        """`--include-busy` neutralise `fetch_busy` : plus d'écartée, plus de retenue."""
        hub = FakeHub([issue(10), issue(20)], [pull(157, closes=10)])
        code, out = run_plan(hub, ["--json", "--include-busy"], DEUX)
        plan = json.loads(out)
        self.assertEqual(code, milestone_plan.OK)
        self.assertEqual(scheduled(plan), {10, 20})
        self.assertEqual(plan["withheld"], [])


class MentionneeNestPasFermee(unittest.TestCase):
    """#308 — une issue citée dans le corps d'une PR n'est pas traitée par elle.

    Le cas réel : la PR #307 ne fermait que #34, mais son corps citait #24, #31,
    #32, #33, #35, #36, #37, #304 et #305 pour justifier sa frontière de
    périmètre. La lecture à la regex les a toutes rendues occupées ; les quatre
    ouvertes du jalon sont sorties du plan, leurs dépendantes ont été retenues
    derrière elles, et le run a conclu que S2 était déroulé sans avoir traité un
    seul ticket.
    """

    def setUp(self):
        self.hub = FakeHub(
            [issue(10), issue(20), issue(30)],
            [pull(157, closes=10, mentions=(20, 30))],
        )

    def test_seule_l_issue_fermee_est_occupee(self):
        with mock.patch.object(milestone_plan, "gh_json", self.hub):
            self.assertEqual(milestone_plan.fetch_busy(), {10: 157})

    def test_les_citees_restent_dispatchables(self):
        _, plan = plan_of(self.hub, DEUX)
        self.assertNotIn(20, ecartees(plan))
        self.assertNotIn(30, ecartees(plan))
        self.assertIn(30, scheduled(plan))

    def test_le_jalon_ne_se_fige_pas_sur_une_pr_bavarde(self):
        """Le symptôme de #308 : zéro vague alors qu'une seule issue est en PR."""
        _, plan = plan_of(self.hub, DEUX)
        self.assertNotEqual(scheduled(plan), set())

    def test_la_branche_designe_son_issue_meme_sans_fermeture(self):
        """Repli : une PR sans mot-clé de fermeture, mais dont la branche nomme l'issue."""
        sans_fermeture = {"number": 158, "body": "un corps qui cite #20 et #30",
                          "headRefName": "bugfix/10-un-travail",
                          "closingIssuesReferences": []}
        with mock.patch.object(milestone_plan, "gh_json",
                               FakeHub([issue(10)], [sans_fermeture])):
            self.assertEqual(milestone_plan.fetch_busy(), {10: 158})

    def test_la_casse_du_depot_ne_jette_pas_les_fermetures(self):
        """`gh` accepte un `--repo` en minuscules, l'API répond en casse d'origine."""
        with mock.patch.object(milestone_plan, "REPO", "tmap-works/spa-booking"):
            with mock.patch.object(milestone_plan, "gh_json", self.hub):
                self.assertEqual(milestone_plan.fetch_busy(), {10: 157})

    def test_une_fermeture_dans_un_autre_depot_ne_compte_pas(self):
        """Un numéro d'issue n'a de sens que dans son dépôt."""
        ailleurs = {
            "number": 159, "body": "", "headRefName": "chore/sans-numero",
            "closingIssuesReferences": [
                {"number": 20, "repository": {"name": "autre-projet",
                                              "owner": {"login": "TMap-Works"}}}
            ],
        }
        with mock.patch.object(milestone_plan, "gh_json",
                               FakeHub([issue(20)], [ailleurs])):
            self.assertEqual(milestone_plan.fetch_busy(), {})


class WithheldBy(unittest.TestCase):
    """La fonction seule — les cas que le bout en bout ne sait pas fabriquer."""

    def test_sans_prerequis_retenu_personne_n_est_retenu(self):
        self.assertEqual(milestone_plan.withheld_by([1, 2], {1: set(), 2: {1}}, set()), {})

    def test_un_graphe_cyclique_ne_fait_pas_boucler(self):
        """`add()` interdit les cycles, mais le point fixe ne doit pas en dépendre."""
        prereqs = {1: {2}, 2: {1}, 3: {1}}
        self.assertEqual(milestone_plan.withheld_by([1, 2, 3], prereqs, {9}), {})
        blocked = milestone_plan.withheld_by([1, 2, 3], {1: {9}, 2: {1}, 3: {2}}, {9})
        self.assertEqual(blocked, {1: {9}, 2: {9}, 3: {9}})

    def test_les_causes_multiples_sont_toutes_remontees(self):
        blocked = milestone_plan.withheld_by([1], {1: {8, 9}}, {8, 9})
        self.assertEqual(blocked, {1: {8, 9}})


if __name__ == "__main__":
    unittest.main()
