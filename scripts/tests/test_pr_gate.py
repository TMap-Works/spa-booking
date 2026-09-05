#!/usr/bin/env python3
"""Tests de la barrière de merge — `scripts/pr_gate.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Pourquoi ces fonctions et pas d'autres : les deux tours de revue de la PR #121
ont trouvé, dans la seule fonction `sensitive()`, six manières distinctes de
laisser passer une PR qu'un humain aurait dû relire — labels cherchés sur la PR
au lieu de l'issue qu'elle referme, `gh` en échec ignoré, mots-clés de fermeture
incomplets, liste de fichiers tronquée à une centaine d'entrées, refus posé
après un retour anticipé, drapeau de contournement. Toutes ont été corrigées, et
toutes vérifiées à la main.

Une régression sur l'une d'elles ne casserait rien de visible : elle remergerait
des PR de paiement ou d'infrastructure sur `develop` sans que personne ne le
remarque. C'est le mode de défaillance que #111 dénonçait — un garde-fou qui ne
se déclenche pas. D'où ce harnais, ouvert en #122.

`sensitive()` décide *qui doit relire* ; `fitness()` et `assess()` décident *si
l'on merge du tout*, et #122 avait laissé ces deux-là sans aucun test. #128 les
couvre, avec les deux fonctions dont elles dépendent : `latest_only()`, qui
choisit le passage à croire quand un workflow a été rejoué, et
`check_entries()`, qui décide quelle conclusion vaut un vert. Leur mode de
défaillance est le même que celui de `sensitive()` — non pas une erreur, mais un
silence : une casse changée côté API, une conclusion oubliée, un passage périmé
préféré au bon, et la barrière laisse merger sans un mot.

Aucune dépendance : `unittest` de la bibliothèque standard. Le dépôt n'a pas de
gestion de paquets Python, et la CI n'a ainsi qu'un interpréteur à poser.
"""
import contextlib
import inspect
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py` qui changeraient la façon dont
# les scripts eux-mêmes s'importent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pr_gate  # noqa: E402 — l'insertion de chemin ci-dessus doit la précéder


def completed(returncode=0, stdout="", stderr=""):
    """Une réponse de sous-processus, telle que `pr_gate.run` en rend."""
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class FakeGh:
    """Double de `pr_gate.run`, qui répond selon la commande et retient les appels.

    `run` est l'unique point par lequel la barrière parle à `gh` et à `git`. Le
    remplacer suffit à jouer n'importe quelle réponse — l'échec en particulier,
    qui est le cas que ces tests surveillent le plus : c'est en ne sachant pas
    que le garde-fou devient muet.

    Une commande qu'aucune règle ne couvre lève : un appel réseau inattendu doit
    faire rougir le test, pas partir vers GitHub.
    """

    def __init__(self, rules):
        self.rules = rules      # [(fragment attendu dans la commande, réponse)]
        self.calls = []

    def __call__(self, args, cwd=None, timeout=120):
        args = list(args)
        self.calls.append(args)
        joined = " ".join(args)
        for needle, result in self.rules:
            if needle in joined:
                return result
        raise AssertionError("commande non prévue par le test : " + joined)


def pr_stub(body="", labels=()):
    """La forme minimale d'une PR telle que `gh pr view --json` la rend."""
    return {"body": body, "labels": [{"name": name} for name in labels]}


def check_run(workflow="CI", name="Tests", status="COMPLETED", conclusion="SUCCESS",
              started="2026-08-25T10:00:00Z", completed="2026-08-25T10:01:00Z"):
    """Une entrée `CheckRun` du rollup — la forme qu'ont nos workflows GitHub."""
    return {"__typename": "CheckRun", "workflowName": workflow, "name": name,
            "status": status, "conclusion": conclusion,
            "startedAt": started, "completedAt": completed}


def status_context(context="couverture", state="SUCCESS"):
    """Une entrée `StatusContext` — l'autre forme, celle d'un statut externe.

    Elle n'a ni `status`, ni `conclusion`, ni horodatage : c'est tout l'intérêt
    de la normaliser, et toute la raison pour laquelle `latest_only()` et
    `check_entries()` la traitent à part.
    """
    return {"__typename": "StatusContext", "context": context, "state": state}


def rollup_pr(rollup, **overrides):
    """Une PR par ailleurs irréprochable : seul le rollup — ou ce qu'on surcharge — varie.

    Partir d'une PR apte est délibéré : `assess()` refuse sur l'inaptitude avant
    de regarder le moindre check, si bien qu'un stub incomplet ferait passer
    n'importe quel test de CI pour vert sans jamais lire son rollup.
    """
    pr = {"state": "OPEN", "isDraft": False, "baseRefName": "develop",
          "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
          "statusCheckRollup": rollup}
    pr.update(overrides)
    return pr


class TestUnattended(unittest.TestCase):
    """`unattended()` — vrai quand personne ne peut répondre à un arbitrage."""

    FAUX = ["", "0", "false", "no", "False", "NO", "  false  "]
    VRAI = ["1", "true", "yes", "TRUE", "Yes", "  1  "]

    def test_valeurs_fausses(self):
        for value in self.FAUX:
            with self.subTest(value=value), mock.patch.dict(
                    os.environ, {pr_gate.UNATTENDED_ENV: value}):
                self.assertFalse(pr_gate.unattended())

    def test_valeurs_vraies(self):
        for value in self.VRAI:
            with self.subTest(value=value), mock.patch.dict(
                    os.environ, {pr_gate.UNATTENDED_ENV: value}):
                self.assertTrue(pr_gate.unattended())

    def test_variable_absente(self):
        with mock.patch.dict(os.environ, clear=True):
            self.assertFalse(pr_gate.unattended())

    def test_valeur_inconnue_vaut_vrai(self):
        # Fail-closed : un drapeau mal orthographié doit rendre la barrière plus
        # stricte, jamais plus permissive.
        with mock.patch.dict(os.environ, {pr_gate.UNATTENDED_ENV: "peut-être"}):
            self.assertTrue(pr_gate.unattended())


class TestClosesKeywords(unittest.TestCase):
    """`CLOSES` — les mots-clés qui relient une PR à l'issue dont on lit les labels.

    N'en reconnaître que trois laissait « Fixed #42 » — pourtant fermant pour
    GitHub — sans aucune lecture de labels, donc sans garde-fou.
    """

    NEUF = ["close", "closes", "closed", "fix", "fixes", "fixed",
            "resolve", "resolves", "resolved"]

    def test_les_neuf_mots_fermants(self):
        for word in self.NEUF:
            with self.subTest(mot=word):
                self.assertEqual(pr_gate.CLOSES.findall(word + " #42"), ["42"])

    def test_insensible_a_la_casse(self):
        for body in ["FIXES #7", "Closed #7", "ReSoLvEs #7"]:
            with self.subTest(corps=body):
                self.assertEqual(pr_gate.CLOSES.findall(body), ["7"])

    def test_mots_non_fermants(self):
        for body in ["Refs #42", "See #42", "Related to #42", "cf #42",
                     "Suite de #42", "Constat de revue de #42"]:
            with self.subTest(corps=body):
                self.assertEqual(pr_gate.CLOSES.findall(body), [])

    def test_faux_amis_lexicaux(self):
        # Un mot-clé enchâssé dans un autre mot ne ferme rien.
        for body in ["closest #42", "unclosed #42", "prefixes #42", "suffix #42"]:
            with self.subTest(corps=body):
                self.assertEqual(pr_gate.CLOSES.findall(body), [])

    def test_plusieurs_issues_dans_un_corps(self):
        body = "Closes #12\n\nCorrige aussi le cas de #99 — fixes #34, resolves #56."
        self.assertEqual(sorted(pr_gate.CLOSES.findall(body)), ["12", "34", "56"])


class TestIssueLabels(unittest.TestCase):
    """`issue_labels()` — les labels vivent sur l'issue, pas sur la PR.

    `/ticket` ouvre ses PR sans `--label` et `tracking.py` n'étiquette que des
    issues : chercher `mod:payments` et `security` sur la PR seule laissait ces
    deux périmètres sans garde-fou.
    """

    def test_labels_lus_sur_l_issue_refermee(self):
        fake = FakeGh([("issue view 42", completed(stdout="mod:payments\nP1\n"))])
        with mock.patch.object(pr_gate, "run", fake):
            labels = pr_gate.issue_labels(pr_stub(body="Closes #42"))
        self.assertEqual(labels, {"mod:payments", "P1"})
        self.assertEqual(fake.calls[0][:4], ["gh", "issue", "view", "42"])

    def test_gh_en_echec_rend_none(self):
        # Ne pas savoir vaut refus : un `gh` en limite de débit rendrait sinon le
        # garde-fou muet précisément quand la charge est forte.
        fake = FakeGh([("issue view 42",
                        completed(returncode=1, stderr="API rate limit exceeded"))])
        with mock.patch.object(pr_gate, "run", fake):
            self.assertIsNone(pr_gate.issue_labels(pr_stub(body="Closes #42")))

    def test_un_echec_parmi_plusieurs_suffit(self):
        fake = FakeGh([("issue view 12", completed(stdout="security\n")),
                       ("issue view 34", completed(returncode=1, stderr="boom"))])
        with mock.patch.object(pr_gate, "run", fake):
            self.assertIsNone(pr_gate.issue_labels(pr_stub(body="Closes #12, fixes #34")))

    def test_union_de_plusieurs_issues(self):
        fake = FakeGh([("issue view 12", completed(stdout="security\n")),
                       ("issue view 34", completed(stdout="mod:infra\nP2\n"))])
        with mock.patch.object(pr_gate, "run", fake):
            labels = pr_gate.issue_labels(pr_stub(body="Closes #12, fixes #34"))
        self.assertEqual(labels, {"security", "mod:infra", "P2"})

    def test_aucun_mot_fermant_aucun_appel_reseau(self):
        fake = FakeGh([])
        with mock.patch.object(pr_gate, "run", fake):
            self.assertEqual(pr_gate.issue_labels(pr_stub(body="Refs #42")), set())
        self.assertEqual(fake.calls, [])

    def test_corps_absent(self):
        with mock.patch.object(pr_gate, "run", FakeGh([])):
            self.assertEqual(pr_gate.issue_labels({}), set())


class TestChangedPaths(unittest.TestCase):
    """`changed_paths()` — les fichiers de la PR, pagination comprise."""

    def test_liste_normalisee(self):
        fake = FakeGh([("pulls/7/files",
                        completed(stdout="a.ts\n\n  infra/terraform/main.tf  \n"))])
        with mock.patch.object(pr_gate, "run", fake):
            paths = pr_gate.changed_paths(7)
        self.assertEqual(paths, ["a.ts", "infra/terraform/main.tf"])

    def test_appel_pagine(self):
        # `--json files` s'arrêtait à une centaine d'entrées : le fichier sensible
        # d'une grosse PR y passait inaperçu.
        fake = FakeGh([("pulls/7/files", completed(stdout=""))])
        with mock.patch.object(pr_gate, "run", fake):
            pr_gate.changed_paths(7)
        command = " ".join(fake.calls[0])
        self.assertIn("--paginate", command)
        self.assertIn("per_page=100", command)

    def test_echec_rend_none(self):
        fake = FakeGh([("pulls/7/files", completed(returncode=1, stderr="boom"))])
        with mock.patch.object(pr_gate, "run", fake):
            self.assertIsNone(pr_gate.changed_paths(7))


class TestSensitive(unittest.TestCase):
    """`sensitive()` — ce qui, dans une PR, appelle une relecture humaine."""

    def reasons(self, pr, paths, from_issue=frozenset()):
        """`sensitive()` avec la lecture des labels d'issue jouée d'avance.

        Elle a ses propres tests ci-dessus ; la neutraliser ici garde chaque cas
        sur un seul sujet.
        """
        with mock.patch.object(pr_gate, "issue_labels", return_value=from_issue):
            return pr_gate.sensitive(pr, paths)

    # --- chaque périmètre, isolément -------------------------------------

    def test_label_mod_payments(self):
        self.assertEqual(self.reasons(pr_stub(), [], {"mod:payments"}),
                         ["label mod:payments"])

    def test_label_security(self):
        self.assertEqual(self.reasons(pr_stub(), [], {"security"}),
                         ["label security"])

    def test_label_porte_par_la_pr_elle_meme(self):
        # Nos PR n'en portent pas, mais un humain peut en poser un à la main.
        self.assertEqual(self.reasons(pr_stub(labels=["security"]), []),
                         ["label security"])

    def test_label_anodin_ignore(self):
        self.assertEqual(self.reasons(pr_stub(), [], {"P0", "ws:devops", "mod:infra"}), [])

    def test_terraform(self):
        self.assertEqual(self.reasons(pr_stub(), ["infra/terraform/dev/main.tf"]),
                         ["infra/terraform"])

    def test_module_payments(self):
        self.assertEqual(
            self.reasons(pr_stub(), ["apps/api/src/modules/payments/refund.service.ts"]),
            ["apps/api/src/modules/payments"])

    def test_schema_prisma(self):
        self.assertEqual(self.reasons(pr_stub(), ["apps/api/prisma/schema.prisma"]),
                         ["schéma ou migration Prisma"])

    def test_migration_prisma(self):
        self.assertEqual(
            self.reasons(pr_stub(),
                         ["apps/api/prisma/migrations/20260101_init/migration.sql"]),
            ["schéma ou migration Prisma"])

    def test_prisma_a_la_racine(self):
        for path in ["prisma/schema.prisma", "prisma/migrations/001/migration.sql"]:
            with self.subTest(chemin=path):
                self.assertEqual(self.reasons(pr_stub(), [path]),
                                 ["schéma ou migration Prisma"])

    # --- cumul ------------------------------------------------------------

    def test_tous_les_perimetres_cumules(self):
        paths = ["README.md",
                 "infra/terraform/prod/main.tf",
                 "apps/api/src/modules/payments/refund.service.ts",
                 "apps/api/prisma/schema.prisma"]
        self.assertEqual(
            self.reasons(pr_stub(), paths, {"mod:payments", "security"}),
            ["label mod:payments", "label security", "infra/terraform",
             "apps/api/src/modules/payments", "schéma ou migration Prisma"])

    def test_un_seul_motif_parmi_beaucoup_de_fichiers(self):
        paths = ["apps/web/src/app/page.tsx"] * 50 + ["infra/terraform/prod/main.tf"]
        self.assertEqual(self.reasons(pr_stub(), paths), ["infra/terraform"])

    # --- ce qui ne doit PAS déclencher ------------------------------------

    def test_pr_anodine(self):
        self.assertEqual(
            self.reasons(pr_stub(), ["README.md", "apps/web/src/app/page.tsx"]), [])

    def test_pr_sans_aucun_fichier(self):
        self.assertEqual(self.reasons(pr_stub(), []), [])

    def test_faux_amis_de_chemins(self):
        faux_amis = [
            "docs/infra/terraform-notes.md",                  # le mot, pas le dossier
            "infra/terraform-notes.md",                       # préfixe sans la barre
            "docs/infra/terraform/guide.md",                  # pas à la racine
            "apps/api/src/modules/payments-legacy/old.ts",    # voisin, pas le module
            "apps/web/src/lib/prismatic.ts",
            "docs/prisma/schema-explique.md",
            "apps/api/prisma/seed.ts",                        # ni schéma ni migration
        ]
        for path in faux_amis:
            with self.subTest(chemin=path):
                self.assertEqual(self.reasons(pr_stub(), [path]), [])

    # --- ne pas savoir vaut refus -----------------------------------------

    def test_liste_de_fichiers_indisponible(self):
        self.assertEqual(self.reasons(pr_stub(), None),
                         ["liste des fichiers indisponible"])

    def test_labels_indisponibles(self):
        self.assertEqual(self.reasons(pr_stub(), [], None),
                         ["labels de l'issue indisponibles"])

    def test_les_deux_indisponibles(self):
        self.assertEqual(self.reasons(pr_stub(), None, None),
                         ["labels de l'issue indisponibles",
                          "liste des fichiers indisponible"])

    def test_label_sensible_conserve_malgre_chemins_indisponibles(self):
        # Le motif tiré des labels est posé AVANT le retour anticipé des chemins.
        # Inversé, il disparaissait du verdict — constat de revue de #121.
        self.assertEqual(self.reasons(pr_stub(), None, {"security"}),
                         ["label security", "liste des fichiers indisponible"])

    # --- la chaîne entière, sans court-circuit ----------------------------

    def test_du_corps_de_la_pr_au_refus(self):
        fake = FakeGh([("issue view 42", completed(stdout="mod:payments\nP0\n"))])
        with mock.patch.object(pr_gate, "run", fake):
            reasons = pr_gate.sensitive(pr_stub(body="Fixed #42"), ["README.md"])
        self.assertEqual(reasons, ["label mod:payments"])


class TestFitness(unittest.TestCase):
    """`fitness()` — ce qui rend une PR inapte au merge, CI mise à part.

    Cinq refus, chacun suspendu à une valeur d'API précise. Une casse ou un nom
    de champ qui changerait côté GitHub les rendrait muets **sans rien casser de
    visible** : la barrière laisserait alors merger un brouillon ou une PR en
    conflit, et le seul symptôme serait un merge qu'on n'attendait pas.
    """

    def fitness(self, base="develop", **overrides):
        """`fitness()` sur une PR apte dont on ne change qu'un champ."""
        return pr_gate.fitness(rollup_pr([], **overrides), base)

    # --- les cinq refus, un par un ----------------------------------------

    def test_pr_fermee(self):
        self.assertEqual(self.fitness(state="CLOSED"),
                         "la PR est closed, pas ouverte")

    def test_pr_deja_mergee(self):
        # Le cas d'une reprise de jalon qui rejoue la barrière sur une PR déjà
        # partie : il doit refuser, pas re-merger.
        self.assertEqual(self.fitness(state="MERGED"),
                         "la PR est merged, pas ouverte")

    def test_pr_en_brouillon(self):
        self.assertEqual(self.fitness(isDraft=True), "la PR est en brouillon")

    def test_mauvaise_base(self):
        self.assertEqual(self.fitness(baseRefName="main"),
                         "la PR cible main au lieu de develop")

    def test_pr_en_conflit(self):
        self.assertEqual(self.fitness(mergeable="CONFLICTING"),
                         "la PR est en conflit avec sa base")

    def test_base_divergee(self):
        self.assertEqual(self.fitness(mergeStateStatus="DIRTY"),
                         "la base a divergé, la PR doit être rebasée")

    def test_les_cinq_motifs_sont_distincts(self):
        """Cinq refus qui rendraient le même message n'en feraient qu'un.

        C'est ce message que l'opérateur lit dans le journal du run : deux
        motifs confondus, et le diagnostic désigne la mauvaise cause.
        """
        motifs = [self.fitness(state="CLOSED"),
                  self.fitness(isDraft=True),
                  self.fitness(baseRefName="main"),
                  self.fitness(mergeable="CONFLICTING"),
                  self.fitness(mergeStateStatus="DIRTY")]
        self.assertEqual(len(set(motifs)), 5)
        self.assertNotIn(None, motifs)

    # --- le cas apte ------------------------------------------------------

    def test_pr_apte(self):
        self.assertIsNone(self.fitness())

    def test_brouillon_absent_ou_faux(self):
        for value in (None, False):
            with self.subTest(isDraft=value):
                self.assertIsNone(self.fitness(isDraft=value))

    def test_la_base_attendue_decide_seule(self):
        # `--base staging` existe : c'est l'attente passée en argument qui fait
        # foi, pas le nom `develop` écrit en dur quelque part.
        self.assertIsNone(self.fitness(base="staging", baseRefName="staging"))
        self.assertEqual(self.fitness(base="staging"),
                         "la PR cible develop au lieu de staging")

    # --- ce qui ne doit PAS refuser ---------------------------------------

    def test_fusion_en_calcul_n_est_pas_une_inaptitude(self):
        # `UNKNOWN` dit que GitHub calcule encore : c'est une attente, et c'est
        # `assess()` qui la tranche. La refuser ici rendrait 3 (« inapte »,
        # définitif) là où la barrière doit rendre 1 (« en cours », réessayable).
        self.assertIsNone(self.fitness(mergeable="UNKNOWN"))

    def test_etats_de_fusion_transitoires(self):
        # BLOCKED, BEHIND et UNSTABLE décrivent l'état des checks, pas celui de
        # la fusion : les refuser doublerait le verdict de la CI, en pire — sans
        # attente ni réessai.
        for status in ("BLOCKED", "BEHIND", "UNSTABLE", "HAS_HOOKS", "UNKNOWN"):
            with self.subTest(mergeStateStatus=status):
                self.assertIsNone(self.fitness(mergeStateStatus=status))

    def test_champs_de_fusion_absents_ou_vides(self):
        # `gh` ne développe pas toujours ces champs. Absents, ils ne doivent
        # rien refuser : c'est `assess()` qui exige des checks, et une PR sans
        # check est déjà bloquée par ailleurs.
        for value in (None, ""):
            with self.subTest(valeur=value):
                self.assertIsNone(self.fitness(mergeable=value,
                                               mergeStateStatus=value))

    # --- la casse et l'ordre ----------------------------------------------

    def test_valeurs_en_minuscules_refusent_quand_meme(self):
        """`.upper()` protège d'une casse changée côté API.

        Sans lui, un `conflicting` en minuscules passerait la barrière sans un
        mot — exactement le mode de défaillance que ce harnais surveille.
        """
        self.assertEqual(self.fitness(mergeable="conflicting"),
                         "la PR est en conflit avec sa base")
        self.assertEqual(self.fitness(mergeStateStatus="dirty"),
                         "la base a divergé, la PR doit être rebasée")

    def test_le_motif_le_plus_structurant_l_emporte(self):
        # Une PR fermée l'est quels que soient ses conflits : annoncer le
        # conflit enverrait rebaser une PR qu'il faut d'abord rouvrir.
        self.assertEqual(
            self.fitness(state="CLOSED", isDraft=True, baseRefName="main",
                         mergeable="CONFLICTING", mergeStateStatus="DIRTY"),
            "la PR est closed, pas ouverte")

    def test_le_brouillon_passe_avant_la_base(self):
        self.assertEqual(self.fitness(isDraft=True, baseRefName="main"),
                         "la PR est en brouillon")


class TestLatestOnly(unittest.TestCase):
    """`latest_only()` — pour un même check, ne garder que son dernier passage.

    C'est la fonction la plus subtile du fichier, et la seule dont une erreur
    peut déclarer **vert sur un résultat périmé**. Un workflow rejoué — titre de
    PR corrigé, `gh run rerun`, PR rouverte — attache au même commit un check
    run de plus sans retirer le précédent. Compter l'ancien condamnerait la PR à
    vie ; ne pas préférer le passage en cours la déclarerait verte pendant que
    la nouvelle exécution tourne encore.
    """

    def kept(self, rollup):
        """Les entrées retenues, réduites à ce qui les distingue."""
        return sorted((item.get("name") or item.get("context"),
                       item.get("conclusion") or item.get("state") or "")
                      for item in pr_gate.latest_only(rollup))

    # --- la déduplication -------------------------------------------------

    def test_passage_rejoue_seul_le_dernier_compte(self):
        vieux = check_run(conclusion="FAILURE", started="2026-08-25T10:00:00Z",
                          completed="2026-08-25T10:05:00Z")
        neuf = check_run(conclusion="SUCCESS", started="2026-08-25T11:00:00Z",
                         completed="2026-08-25T11:05:00Z")
        self.assertEqual(self.kept([vieux, neuf]), [("Tests", "SUCCESS")])

    def test_l_ordre_d_arrivee_est_indifferent(self):
        # Le rollup n'est pas trié : se fier à sa position rendrait le verdict
        # dépendant de l'ordre où GitHub a écrit les entrées.
        vieux = check_run(conclusion="FAILURE", started="2026-08-25T10:00:00Z")
        neuf = check_run(conclusion="SUCCESS", started="2026-08-25T11:00:00Z")
        self.assertEqual(self.kept([neuf, vieux]), [("Tests", "SUCCESS")])
        self.assertEqual(self.kept([vieux, neuf]), [("Tests", "SUCCESS")])

    def test_completedAt_departage_deux_passages_de_la_meme_seconde(self):
        # Deux relances lancées dans la même seconde ont le même `startedAt` :
        # sans second critère, le gagnant dépendrait de l'ordre du rollup.
        vieux = check_run(conclusion="FAILURE", started="2026-08-25T10:00:00Z",
                          completed="2026-08-25T10:04:00Z")
        neuf = check_run(conclusion="SUCCESS", started="2026-08-25T10:00:00Z",
                         completed="2026-08-25T10:09:00Z")
        # Les deux ordres, sinon le test passerait tout autant sans ce second
        # critère : à rangs égaux, c'est la première entrée vue qui est gardée.
        self.assertEqual(self.kept([neuf, vieux]), [("Tests", "SUCCESS")])
        self.assertEqual(self.kept([vieux, neuf]), [("Tests", "SUCCESS")])

    def test_un_echec_perime_ne_condamne_plus_la_pr(self):
        """L'effet recherché, vu du verdict.

        Rien de ce qu'on pousse ne détache un échec déjà inscrit sur un commit :
        sans déduplication, la seule issue serait de réécrire l'historique pour
        obtenir un SHA neuf — tordre le dépôt pour satisfaire la barrière.
        """
        code, message, checks = pr_gate.assess(rollup_pr([
            check_run(conclusion="FAILURE", started="2026-08-25T10:00:00Z"),
            check_run(conclusion="SUCCESS", started="2026-08-25T11:00:00Z"),
        ]), "develop", False)
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual(message, "1 check(s) au vert")
        self.assertEqual(checks, [("CI / Tests", "pass", "SUCCESS")])

    # --- un passage en cours l'emporte toujours ---------------------------

    def test_un_passage_en_cours_l_emporte_sur_un_termine_plus_recent(self):
        """La règle qui protège du « vert sur résultat périmé ».

        Un check run encore en file n'a pas forcément de `startedAt`
        exploitable : le comparer par les dates ferait gagner l'ancien, et la
        barrière déclarerait vert pendant que la nouvelle exécution tourne.
        """
        termine = check_run(conclusion="SUCCESS", started="2026-08-25T12:00:00Z",
                            completed="2026-08-25T12:05:00Z")
        en_cours = check_run(status="QUEUED", conclusion=None,
                             started=None, completed=None)
        self.assertEqual(self.kept([termine, en_cours]), [("Tests", "")])
        self.assertEqual(self.kept([en_cours, termine]), [("Tests", "")])

    def test_une_relance_en_cours_fait_attendre_malgre_un_succes_anterieur(self):
        code, message, _ = pr_gate.assess(rollup_pr([
            check_run(conclusion="SUCCESS", started="2026-08-25T12:00:00Z"),
            check_run(status="IN_PROGRESS", conclusion=None,
                      started=None, completed=None),
        ]), "develop", False)
        self.assertEqual(code, pr_gate.PENDING)
        self.assertEqual(message, "1 check(s) en cours")

    def test_termine_sans_conclusion_compte_comme_en_cours(self):
        # `COMPLETED` sans conclusion est un état transitoire de l'API : le
        # prendre pour un passage clos ferait gagner une entrée qui ne dit rien.
        sans_verdict = check_run(status="COMPLETED", conclusion=None,
                                 started="2026-08-25T09:00:00Z")
        termine = check_run(conclusion="SUCCESS", started="2026-08-25T12:00:00Z")
        self.assertEqual(self.kept([termine, sans_verdict]), [("Tests", "")])

    def test_deux_passages_en_cours_se_departagent_par_la_date(self):
        vieux = check_run(status="QUEUED", conclusion=None, name="Tests",
                          started="2026-08-25T10:00:00Z", completed=None)
        neuf = check_run(status="IN_PROGRESS", conclusion=None, name="Tests",
                         started="2026-08-25T11:00:00Z", completed=None)
        retenus = pr_gate.latest_only([vieux, neuf])
        self.assertEqual([item["status"] for item in retenus], ["IN_PROGRESS"])

    # --- ce qui ne doit PAS être dédupliqué -------------------------------

    def test_deux_jobs_du_meme_workflow_coexistent(self):
        self.assertEqual(
            self.kept([check_run(name="Tests"), check_run(name="Lint")]),
            [("Lint", "SUCCESS"), ("Tests", "SUCCESS")])

    def test_deux_workflows_avec_le_meme_nom_de_job_coexistent(self):
        # Dédupliquer sur le seul nom de job masquerait l'échec de l'un des deux.
        retenus = pr_gate.latest_only([
            check_run(workflow="CI", name="Tests", conclusion="SUCCESS"),
            check_run(workflow="Terraform", name="Tests", conclusion="FAILURE"),
        ])
        self.assertEqual(
            sorted((item["workflowName"], item["conclusion"]) for item in retenus),
            [("CI", "SUCCESS"), ("Terraform", "FAILURE")])

    def test_un_job_matriciel_garde_ses_variantes(self):
        # Deux passages d'un même workflow ne coexistent pas dans un run : un
        # job matriciel porte ses paramètres dans son nom, et reste distinct.
        self.assertEqual(
            self.kept([check_run(name="Tests (node 20)", conclusion="SUCCESS"),
                       check_run(name="Tests (node 22)", conclusion="FAILURE")]),
            [("Tests (node 20)", "SUCCESS"), ("Tests (node 22)", "FAILURE")])

    def test_un_statut_externe_et_un_check_homonymes_ne_se_confondent_pas(self):
        # Ils ne viennent pas de la même source : les confondre ferait taire le
        # rouge de l'un au nom du vert de l'autre.
        retenus = pr_gate.latest_only([
            status_context(context="Tests", state="FAILURE"),
            check_run(workflow="", name="Tests", conclusion="SUCCESS"),
        ])
        self.assertEqual(len(retenus), 2)

    # --- les statuts externes ---------------------------------------------

    def test_statuts_externes_dedupliques_par_contexte(self):
        retenus = pr_gate.latest_only([
            status_context(context="couverture", state="FAILURE"),
            status_context(context="couverture", state="SUCCESS"),
        ])
        self.assertEqual(len(retenus), 1)

    def test_un_statut_externe_en_attente_l_emporte(self):
        # Un `StatusContext` n'a aucun horodatage : seule la règle « en cours
        # l'emporte » peut le départager, dans un sens comme dans l'autre.
        for etat in ("PENDING", "EXPECTED"):
            with self.subTest(state=etat):
                self.assertEqual(
                    self.kept([status_context(state="SUCCESS"),
                               status_context(state=etat)]),
                    [("couverture", etat)])
                self.assertEqual(
                    self.kept([status_context(state=etat),
                               status_context(state="SUCCESS")]),
                    [("couverture", etat)])

    def test_statut_externe_en_attente_reconnu_quelle_que_soit_la_casse(self):
        self.assertEqual(
            self.kept([status_context(state="SUCCESS"),
                       status_context(state="pending")]),
            [("couverture", "pending")])

    # --- les cas dégénérés ------------------------------------------------

    def test_rollup_vide_ou_absent(self):
        for rollup in ([], None):
            with self.subTest(rollup=rollup):
                self.assertEqual(pr_gate.latest_only(rollup), [])

    def test_entree_sans_le_moindre_champ(self):
        # Une entrée nue reste une entrée : la perdre ferait disparaître un
        # check du décompte, donc un vert de plus dans le verdict.
        self.assertEqual(len(pr_gate.latest_only([{}])), 1)


class TestCheckEntries(unittest.TestCase):
    """`check_entries()` — la normalisation du rollup hétérogène de GitHub.

    Deux formes (`CheckRun`, `StatusContext`), trois états (`pass`, `pending`,
    `fail`). C'est ici que se décide ce qui passe : `SKIPPED` et `NEUTRAL`
    passent — sans quoi `terraform.yml` filtré par chemin et
    `project-automation.yml` sans `PROJECT_TOKEN` bloqueraient tous les merges —
    tandis que `CANCELLED` et `TIMED_OUT` bloquent.
    """

    def entry(self, item):
        entries = list(pr_gate.check_entries([item]))
        self.assertEqual(len(entries), 1, "une entrée du rollup, une sortie")
        return entries[0]

    # --- ce qui passe -----------------------------------------------------

    def test_conclusions_qui_passent(self):
        for conclusion in ("SUCCESS", "SKIPPED", "NEUTRAL"):
            with self.subTest(conclusion=conclusion):
                self.assertEqual(self.entry(check_run(conclusion=conclusion)),
                                 ("CI / Tests", "pass", conclusion))

    def test_skipped_et_neutral_ne_sont_pas_des_attentes(self):
        # Les compter en attente serait pire qu'un refus franc : la barrière
        # sonderait jusqu'au délai un workflow qui ne conclura jamais autrement.
        for conclusion in ("SKIPPED", "NEUTRAL"):
            with self.subTest(conclusion=conclusion):
                self.assertNotEqual(
                    self.entry(check_run(conclusion=conclusion))[1], "pending")

    def test_la_liste_des_conclusions_passantes_est_close(self):
        """Trois conclusions passent, et trois seulement.

        En ajouter une ici — `CANCELLED` par mégarde — ouvrirait la barrière
        sans qu'aucun autre test ne le remarque.
        """
        self.assertEqual(pr_gate.PASSING, {"SUCCESS", "SKIPPED", "NEUTRAL"})

    # --- ce qui bloque ----------------------------------------------------

    def test_conclusions_qui_bloquent(self):
        for conclusion in ("FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED",
                           "STARTUP_FAILURE", "STALE"):
            with self.subTest(conclusion=conclusion):
                self.assertEqual(self.entry(check_run(conclusion=conclusion)),
                                 ("CI / Tests", "fail", conclusion))

    def test_cancelled_et_timed_out_ne_sont_ni_passants_ni_en_attente(self):
        """Les deux conclusions que l'on serait tenté de tolérer.

        Un run annulé n'a rien prouvé, un run expiré non plus. Les traiter en
        attente ferait tourner la barrière jusqu'à son propre délai ; les
        traiter en passants mergerait sur du vide.
        """
        for conclusion in ("CANCELLED", "TIMED_OUT"):
            with self.subTest(conclusion=conclusion):
                self.assertEqual(self.entry(check_run(conclusion=conclusion))[1],
                                 "fail")

    # --- ce qui fait attendre ---------------------------------------------

    def test_statuts_en_cours(self):
        for status in ("QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"):
            with self.subTest(status=status):
                self.assertEqual(
                    self.entry(check_run(status=status, conclusion=None)),
                    ("CI / Tests", "pending", status))

    def test_un_passage_relance_peut_porter_l_ancienne_conclusion(self):
        # Le statut prime sur la conclusion : une entrée non terminée qui traîne
        # encore le verdict du passage précédent doit faire attendre, pas passer.
        self.assertEqual(
            self.entry(check_run(status="IN_PROGRESS", conclusion="SUCCESS")),
            ("CI / Tests", "pending", "IN_PROGRESS"))

    def test_termine_sans_conclusion_fait_attendre(self):
        self.assertEqual(
            self.entry(check_run(status="COMPLETED", conclusion=None)),
            ("CI / Tests", "pending", "COMPLETED"))

    def test_ni_statut_ni_conclusion(self):
        self.assertEqual(self.entry({"__typename": "CheckRun", "name": "Tests"}),
                         ("Tests", "pending", "PENDING"))

    # --- la casse ---------------------------------------------------------

    def test_casse_ignoree_sur_la_conclusion(self):
        self.assertEqual(self.entry(check_run(conclusion="success"))[1], "pass")
        self.assertEqual(self.entry(check_run(conclusion="failure")),
                         ("CI / Tests", "fail", "FAILURE"))

    def test_casse_ignoree_sur_le_statut(self):
        self.assertEqual(
            self.entry(check_run(status="in_progress", conclusion=None)),
            ("CI / Tests", "pending", "IN_PROGRESS"))

    # --- le nom rendu, celui que l'opérateur lit --------------------------

    def test_nom_compose_du_workflow_et_du_job(self):
        self.assertEqual(self.entry(check_run(workflow="CI", name="Lint"))[0],
                         "CI / Lint")

    def test_nom_non_redondant(self):
        # Un workflow d'un seul job porte le même nom que lui : « CI / CI »
        # n'apprendrait rien.
        self.assertEqual(self.entry(check_run(workflow="CI", name="CI"))[0], "CI")

    def test_nom_sans_workflow(self):
        for workflow in (None, ""):
            with self.subTest(workflowName=workflow):
                self.assertEqual(self.entry(check_run(workflow=workflow,
                                                      name="Tests"))[0], "Tests")

    def test_nom_absent(self):
        self.assertEqual(self.entry({"__typename": "CheckRun"})[0], "check")

    # --- les statuts externes ---------------------------------------------

    def test_statut_externe_reussi(self):
        self.assertEqual(self.entry(status_context(state="SUCCESS")),
                         ("couverture", "pass", "SUCCESS"))

    def test_statut_externe_en_attente(self):
        for state in ("PENDING", "EXPECTED"):
            with self.subTest(state=state):
                self.assertEqual(self.entry(status_context(state=state)),
                                 ("couverture", "pending", state))

    def test_statut_externe_en_echec(self):
        for state in ("FAILURE", "ERROR"):
            with self.subTest(state=state):
                self.assertEqual(self.entry(status_context(state=state)),
                                 ("couverture", "fail", state))

    def test_statut_externe_sans_etat_bloque(self):
        # Fail-closed : un statut externe qu'on ne sait pas lire n'est pas un
        # statut vert.
        self.assertEqual(self.entry(status_context(state="")),
                         ("couverture", "fail", "INCONNU"))

    def test_statut_externe_sans_contexte(self):
        self.assertEqual(self.entry({"__typename": "StatusContext",
                                     "state": "SUCCESS"})[0], "statut externe")

    def test_statut_externe_casse_ignoree(self):
        self.assertEqual(self.entry(status_context(state="success"))[1], "pass")
        self.assertEqual(self.entry(status_context(state="pending"))[1], "pending")

    # --- le rollup entier -------------------------------------------------

    def test_rollup_vide_ou_absent(self):
        for rollup in ([], None):
            with self.subTest(rollup=rollup):
                self.assertEqual(list(pr_gate.check_entries(rollup)), [])

    def test_les_deux_formes_melangees(self):
        entries = list(pr_gate.check_entries([
            check_run(name="Tests", conclusion="SKIPPED"),
            status_context(context="couverture", state="FAILURE"),
        ]))
        self.assertEqual(entries, [("CI / Tests", "pass", "SKIPPED"),
                                   ("couverture", "fail", "FAILURE")])


class TestAssess(unittest.TestCase):
    """`assess()` — l'unique endroit qui décide, et l'ordre dans lequel il décide.

    Cet ordre **est** la décision. Un échec doit l'emporter sur une attente,
    sans quoi la barrière sonderait jusqu'à son délai une PR déjà perdue ; une
    attente doit l'emporter sur un vert, sans quoi elle mergerait avant la fin ;
    et l'absence de check doit bloquer, parce qu'elle signifie qu'aucun workflow
    ne s'est déclenché, pas que tout va bien.
    """

    def assess(self, rollup, allow_no_checks=False, base="develop", **overrides):
        return pr_gate.assess(rollup_pr(rollup, **overrides), base, allow_no_checks)

    # --- l'inaptitude court-circuite la CI --------------------------------

    def test_inaptitude_prioritaire_sur_tout(self):
        # Diagnostiquer la CI d'un brouillon enverrait corriger des checks alors
        # que la PR n'est pas même candidate.
        code, message, checks = self.assess(
            [check_run(conclusion="FAILURE")], isDraft=True)
        self.assertEqual(code, pr_gate.UNFIT)
        self.assertEqual(message, "la PR est en brouillon")
        self.assertEqual(checks, [])

    def test_inaptitude_meme_sans_le_moindre_check(self):
        code, message, _ = self.assess(None, state="CLOSED")
        self.assertEqual(code, pr_gate.UNFIT)
        self.assertEqual(message, "la PR est closed, pas ouverte")

    # --- l'ordre entre échec, attente et vert -----------------------------

    def test_tout_au_vert(self):
        code, message, _ = self.assess([check_run(name="Tests"),
                                        check_run(name="Lint")])
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual(message, "2 check(s) au vert")

    def test_echec_prioritaire_sur_attente(self):
        code, message, _ = self.assess([
            check_run(name="Tests", conclusion="FAILURE"),
            check_run(name="Build", status="QUEUED", conclusion=None),
        ])
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual(message, "1 check(s) en échec")

    def test_attente_prioritaire_sur_le_vert(self):
        code, message, _ = self.assess([
            check_run(name="Tests"),
            check_run(name="Build", status="IN_PROGRESS", conclusion=None),
        ])
        self.assertEqual(code, pr_gate.PENDING)
        self.assertEqual(message, "1 check(s) en cours")

    def test_les_echecs_sont_comptes(self):
        code, message, _ = self.assess([
            check_run(name="Tests", conclusion="FAILURE"),
            check_run(name="Lint", conclusion="CANCELLED"),
            check_run(name="Build"),
        ])
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual(message, "2 check(s) en échec")

    # --- la fusion que GitHub calcule encore ------------------------------

    def test_fusion_inconnue_fait_attendre(self):
        # `mergeable: UNKNOWN` : GitHub calcule encore la fusion et refuserait
        # le merge. Passer outre échouerait au moment d'agir, sans réessai.
        code, message, checks = self.assess([check_run()], mergeable="UNKNOWN")
        self.assertEqual(code, pr_gate.PENDING)
        self.assertEqual(message, "GitHub calcule encore la fusion")
        self.assertEqual([name for name, _, _ in checks], ["CI / Tests"])

    def test_fusion_inconnue_quelle_que_soit_la_casse(self):
        code, _, _ = self.assess([check_run()], mergeable="unknown")
        self.assertEqual(code, pr_gate.PENDING)

    def test_echec_prioritaire_sur_la_fusion_en_calcul(self):
        # Un échec est définitif, la fusion en calcul ne l'est pas : rendre 1
        # ferait sonder jusqu'au délai une PR qu'il faut réparer maintenant.
        code, message, _ = self.assess([check_run(conclusion="FAILURE")],
                                       mergeable="UNKNOWN")
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual(message, "1 check(s) en échec")

    def test_attente_de_check_annoncee_avant_la_fusion(self):
        # Les deux rendent 1 ; c'est le message qui change, et c'est lui que
        # l'opérateur lit pour savoir ce qu'on attend.
        code, message, _ = self.assess(
            [check_run(status="QUEUED", conclusion=None)], mergeable="UNKNOWN")
        self.assertEqual(code, pr_gate.PENDING)
        self.assertEqual(message, "1 check(s) en cours")

    def test_fusion_absente_ou_vide_ne_fait_pas_attendre(self):
        for value in (None, "", "MERGEABLE"):
            with self.subTest(mergeable=value):
                code, _, _ = self.assess([check_run()], mergeable=value)
                self.assertEqual(code, pr_gate.GREEN)

    # --- aucun check déclaré ----------------------------------------------

    def test_aucun_check_bloque(self):
        """Le cas qui doit bloquer, et qu'on prendrait volontiers pour un vert.

        Une PR sans aucun check ne dit pas que tout va bien : elle dit
        qu'aucun workflow ne s'est déclenché.
        """
        for rollup in ([], None):
            with self.subTest(rollup=rollup):
                code, message, checks = self.assess(rollup)
                self.assertEqual(code, pr_gate.PENDING)
                self.assertEqual(message, "aucun check déclaré pour l'instant")
                self.assertEqual(checks, [])

    def test_aucun_check_tolere_par_le_drapeau(self):
        code, message, checks = self.assess([], allow_no_checks=True)
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual(message, "aucun check déclaré (toléré)")
        self.assertEqual(checks, [])

    def test_le_drapeau_ne_tolere_que_l_absence(self):
        # `--allow-no-checks` dit « aucun workflow ne tourne sur cette PR », pas
        # « ignore les checks » : il ne doit rien excuser d'autre.
        code, message, _ = self.assess([check_run(conclusion="FAILURE")],
                                       allow_no_checks=True)
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual(message, "1 check(s) en échec")

    def test_le_drapeau_ne_raccourcit_pas_une_attente(self):
        code, message, _ = self.assess(
            [check_run(status="QUEUED", conclusion=None)], allow_no_checks=True)
        self.assertEqual(code, pr_gate.PENDING)
        self.assertEqual(message, "1 check(s) en cours")

    # --- ce que le verdict rend à l'affichage -----------------------------

    def test_les_checks_rendus_alimentent_l_affichage(self):
        # `main()` les passe à `show()` : un verdict sans détail laisserait
        # l'opérateur avec un code de sortie et rien pour le comprendre.
        _, _, checks = self.assess([check_run(name="Tests", conclusion="FAILURE"),
                                    check_run(name="Lint", conclusion="SKIPPED")])
        self.assertEqual(sorted(checks), [("CI / Lint", "pass", "SKIPPED"),
                                          ("CI / Tests", "fail", "FAILURE")])

    def test_les_conclusions_tolerees_font_un_vert(self):
        code, message, _ = self.assess([check_run(name="Terraform",
                                                  conclusion="SKIPPED"),
                                        check_run(name="Project",
                                                  conclusion="NEUTRAL")])
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual(message, "2 check(s) au vert")

    def test_un_statut_externe_rouge_bloque(self):
        code, message, _ = self.assess([check_run(),
                                        status_context(state="FAILURE")])
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual(message, "1 check(s) en échec")


class TestSansLeWorkflowDAutoMerge(unittest.TestCase):
    """`assess()` — le workflow qui merge n'est pas un check qu'on attend.

    Déclenché par `pull_request_target`, son run est rattaché à la PR et
    s'inscrit dans ses checks. La barrière s'y voyait elle-même « en cours » et
    rendait 1 ; ce 1 avortait l'étape qui l'appelait, le job rougissait, et son
    échec devenait un check rouge de la PR. Rouge définitif : les réveils
    suivants viennent de `workflow_run`, rattaché à la branche par défaut, et ne
    rafraîchissent jamais l'entrée. Deux PR vertes en sont mortes — #145 et
    #146. Voir #147.
    """

    JOB = "Merger les PR étiquetées et vertes"

    # La fabrique partagée, sous le nom qu'utilisent les cas ci-dessous : deux
    # stubs de check run qui divergeraient laisseraient un jour ces tests-ci
    # passer sur une forme d'entrée que la barrière ne reçoit plus.
    check = staticmethod(check_run)

    def assess(self, rollup):
        """`assess()` sur une PR par ailleurs irréprochable : seul le rollup varie."""
        return pr_gate.assess(rollup_pr(rollup), "develop", False)

    # --- ce que la barrière ne doit plus voir -----------------------------

    def test_son_propre_passage_en_cours_ne_l_attend_pas(self):
        code, _, checks = self.assess([
            self.check("CI", "Tests"),
            self.check(pr_gate.MERGE_WORKFLOW, self.JOB,
                       status="IN_PROGRESS", conclusion=None),
        ])
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual([name for name, _, _ in checks], ["CI / Tests"])

    def test_son_echec_deja_inscrit_ne_condamne_plus(self):
        # L'état exact de #145 et #146 : tout au vert, sauf le job qui merge.
        code, _, checks = self.assess([
            self.check("CI", "Tests"),
            self.check(pr_gate.MERGE_WORKFLOW, self.JOB, conclusion="FAILURE"),
        ])
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual([name for name, _, _ in checks], ["CI / Tests"])

    def test_rollup_sans_workflow_developpe(self):
        # Repli sur `name` quand le rollup ne développe pas `workflowName`.
        code, _, checks = self.assess([
            self.check("CI", "Tests"),
            {"__typename": "CheckRun", "name": pr_gate.MERGE_WORKFLOW,
             "status": "IN_PROGRESS", "conclusion": None},
        ])
        self.assertEqual(code, pr_gate.GREEN)
        self.assertEqual([name for name, _, _ in checks], ["CI / Tests"])

    # --- ce qu'elle doit continuer de voir --------------------------------

    def test_les_autres_echecs_bloquent_toujours(self):
        code, message, _ = self.assess([
            self.check("CI", "Tests", conclusion="FAILURE"),
            self.check(pr_gate.MERGE_WORKFLOW, self.JOB, conclusion="FAILURE"),
        ])
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual(message, "1 check(s) en échec")

    def test_les_autres_attentes_font_toujours_attendre(self):
        code, message, _ = self.assess([
            self.check("CI", "Build", status="QUEUED", conclusion=None),
            self.check(pr_gate.MERGE_WORKFLOW, self.JOB, conclusion="FAILURE"),
        ])
        self.assertEqual(code, pr_gate.PENDING)
        self.assertEqual(message, "1 check(s) en cours")

    def test_une_pr_reduite_a_ce_seul_check_reste_en_attente(self):
        # L'écarter ne doit pas fabriquer un vert : plus aucun check déclaré
        # signifie qu'aucun workflow n'a tourné, pas que tout va bien.
        code, message, checks = self.assess(
            [self.check(pr_gate.MERGE_WORKFLOW, self.JOB)])
        self.assertEqual(code, pr_gate.PENDING)
        self.assertEqual(message, "aucun check déclaré pour l'instant")
        self.assertEqual(checks, [])

    def test_un_statut_externe_homonyme_est_conserve(self):
        # Un statut externe ne vient d'aucun workflow : l'écarter sur son seul
        # nom laisserait passer le rouge de quelqu'un d'autre.
        code, _, checks = self.assess([
            {"__typename": "StatusContext", "context": pr_gate.MERGE_WORKFLOW,
             "state": "FAILURE"},
        ])
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual([name for name, _, _ in checks], [pr_gate.MERGE_WORKFLOW])

    def test_un_check_d_application_homonyme_est_conserve(self):
        # Un check run posé par une application GitHub porte un `workflowName`
        # vide, pas absent : il ne vient d'aucun workflow, et l'écarter sur son
        # seul nom laisserait passer le rouge de quelqu'un d'autre.
        code, _, checks = self.assess([
            {"__typename": "CheckRun", "workflowName": "",
             "name": pr_gate.MERGE_WORKFLOW,
             "status": "COMPLETED", "conclusion": "FAILURE"},
        ])
        self.assertEqual(code, pr_gate.FAILED)
        self.assertEqual([name for name, _, _ in checks], [pr_gate.MERGE_WORKFLOW])

    def test_rollup_vide_ou_absent(self):
        for rollup in ([], None):
            with self.subTest(rollup=rollup):
                self.assertEqual(pr_gate.without_merge_workflow(rollup), [])

    # --- la constante ne doit pas dériver du workflow ---------------------

    def test_le_nom_suit_celui_declare_par_le_workflow(self):
        """Une constante recopiée finit par désigner un workflow qui n'existe plus.

        Renommer `auto-merge.yml` sans toucher ici rétablirait la panne à
        l'identique, et rien ne le dirait avant qu'une PR verte ne meure.
        """
        source = (pr_gate.ROOT / ".github" / "workflows" / "auto-merge.yml"
                  ).read_text(encoding="utf-8")
        declared = re.search(r"(?m)^name:[ \t]*(.+?)[ \t]*$", source)
        self.assertIsNotNone(declared, "auto-merge.yml n'a plus de `name:`")
        self.assertEqual(declared.group(1), pr_gate.MERGE_WORKFLOW)


class SansIntention(unittest.TestCase):
    """Socle des classes qui n'éprouvent que la lecture de la variable.

    Sans cela, ces tests liraient le `supervisor.json` **réel** du poste qui les
    exécute : leurs attentes dépendraient de l'armement du moment, et la suite
    passerait ou non selon le jalon en cours. On les place donc là où il n'y a
    aucune intention à confronter — ce que `intent_scopes()` traite comme « on ne
    sait pas », c'est-à-dire le comportement d'avant #414.
    """

    def setUp(self):
        absente = Path(__file__).resolve().parent / "intention-qui-n-existe-pas.json"
        self.assertFalse(absente.exists())
        patch = mock.patch.object(pr_gate, "INTENT", absente)
        patch.start()
        self.addCleanup(patch.stop)


class TestAuthorisedScopes(SansIntention):
    """`authorised_scopes()` — ce que l'opérateur a autorisé avant de partir.

    La variable dit ce qui a **déjà été répondu**, là où `SPA_UNATTENDED` dit
    seulement que personne ne peut répondre maintenant. Confondre les deux (#156)
    revenait à interdire tout merge sensible dès que l'opérateur s'absentait,
    c'est-à-dire à ne jamais se servir de la reprise automatique.
    """

    def scopes(self, value):
        with mock.patch.dict(os.environ, {pr_gate.AUTHORISED_ENV: value}):
            return pr_gate.authorised_scopes()

    def test_variable_absente_n_autorise_rien(self):
        with mock.patch.dict(os.environ, clear=True):
            self.assertEqual(pr_gate.authorised_scopes(), set())

    def test_variable_vide_n_autorise_rien(self):
        # Le superviseur la pose toujours, même vide : la lire comme « tout »
        # ferait de l'armement le plus prudent le plus permissif.
        self.assertEqual(self.scopes(""), set())

    def test_une_seule_cle(self):
        self.assertEqual(self.scopes("infra/terraform"), {"infra/terraform"})

    def test_plusieurs_cles_separees_par_des_virgules(self):
        self.assertEqual(self.scopes("infra/terraform,prisma"),
                         {"infra/terraform", "prisma"})

    def test_espaces_et_casse_tolerees(self):
        self.assertEqual(self.scopes("  INFRA/Terraform ,  prisma  "),
                         {"infra/terraform", "prisma"})

    def test_all_prend_tous_les_perimetres(self):
        self.assertEqual(self.scopes(pr_gate.ALL_SCOPES), set(pr_gate.SCOPE_KEYS))

    def test_cle_inconnue_n_ouvre_rien(self):
        # Fail-closed, comme `unattended()` : une faute de frappe rend la
        # barrière plus stricte, jamais plus permissive. Le refus franc se fait
        # à l'armement, là où quelqu'un peut encore corriger.
        self.assertEqual(
            pr_gate.blocking(["infra/terraform"], self.scopes("terraform")),
            ["infra/terraform"])


class TestScopesDeLAppel(SansIntention):
    """`--merge-sensitive` : la même autorisation, mais donnée PR par PR.

    Elle existe pour l'arbitre du run, qui n'autorise qu'après avoir lu le diff
    et publié sa revue. Le faire passer par la variable d'environnement
    l'obligerait à écrire `SPA_MERGE_SENSITIVE=… python …`, une forme que
    l'allowlist de `.claude/settings.json` ne reconnaît pas : son mandat de merge
    aurait été refusé en silence sous `claude -p`.
    """

    def scopes(self, extra, env=None):
        with mock.patch.dict(os.environ, env or {}, clear=True):
            return pr_gate.authorised_scopes(extra)

    def test_le_drapeau_ouvre_un_perimetre(self):
        self.assertEqual(self.scopes("infra/terraform"), {"infra/terraform"})

    def test_le_drapeau_vide_n_ouvre_rien(self):
        self.assertEqual(self.scopes(""), set())

    def test_le_drapeau_s_ajoute_a_l_armement_du_run(self):
        """L'un dit ce qui a été autorisé pour tout le run, l'autre ce que
        l'arbitre autorise ici : ni l'un ni l'autre ne doit effacer le second."""
        found = self.scopes("prisma",
                            env={pr_gate.AUTHORISED_ENV: "infra/terraform"})
        self.assertEqual(found, {"infra/terraform", "prisma"})

    def test_une_cle_inconnue_au_drapeau_reste_inerte(self):
        self.assertEqual(
            pr_gate.blocking(["infra/terraform"], self.scopes("terraform")),
            ["infra/terraform"])

    def test_all_reste_possible_mais_la_commande_l_interdit(self):
        """La barrière l'accepte — c'est la commande d'arbitrage qui interdit à
        l'arbitre de l'écrire. Le vérifier ici documente où vit la limite."""
        self.assertEqual(self.scopes(pr_gate.ALL_SCOPES), set(pr_gate.SCOPE_KEYS))


class TestConfrontationDeLIntention(unittest.TestCase):
    """`authorised_scopes()` face à `supervisor.json` — le défaut #414.

    La variable est figée dans l'environnement du `claude -p` au moment où il
    naît ; l'intention du run, elle, se réécrit sur le disque à chaque
    réarmement. Les deux divergent donc dès qu'on réarme pendant qu'une vague
    vole — ce qui est arrivé le 5 septembre 2026 à une minute d'intervalle : la
    vague ouverte sous `--merge-sensitive all` a continué d'annoncer les cinq
    périmètres alors que `supervisor.json` portait déjà `"merge_sensitive": []`.

    `pr_gate.py` ne décidait qu'à partir de la variable. Il annonçait donc
    « périmètre sensible pré-autorisé à l'armement du run — merge poursuivi »
    sur une PR que personne n'avait autorisée, et `mod:payments` comme `security`
    — la frontière PCI SAQ A du CDC — passaient au merge non relu.

    Ce qui est vérifié ici est la confrontation dans **les deux sens** : le
    désaccord doit retenir la plus restrictive et le dire en `ERROR`, l'accord
    ne doit strictement rien changer. Une régression sur le second serait tout
    aussi grave que sur le premier : elle rendrait inerte le
    `--merge-sensitive infra/terraform,prisma` d'un opérateur, et la reprise
    automatique cesserait de merger sans que rien ne le dise.
    """

    def setUp(self):
        self.dossier = tempfile.TemporaryDirectory()
        self.addCleanup(self.dossier.cleanup)
        self.intention = Path(self.dossier.name) / "supervisor.json"
        patch = mock.patch.object(pr_gate, "INTENT", self.intention)
        patch.start()
        self.addCleanup(patch.stop)

    def arme(self, scopes, **reste):
        """Écrit une intention de run, comme `milestone_supervise` l'écrit."""
        intent = {"milestone": "S3", "no_merge": False,
                  pr_gate.INTENT_KEY: list(scopes)}
        intent.update(reste)
        self.intention.write_text(json.dumps(intent, ensure_ascii=False),
                                  encoding="utf-8")

    def scopes(self, variable, extra=""):
        """Rend (périmètres retenus, ce qui a été écrit sur stderr)."""
        erreurs = io.StringIO()
        with mock.patch.dict(os.environ, {pr_gate.AUTHORISED_ENV: variable},
                             clear=True):
            with contextlib.redirect_stderr(erreurs):
                return pr_gate.authorised_scopes(extra), erreurs.getvalue()

    # --- désaccord : on retient la plus restrictive, et on le dit ----------

    def test_le_cas_de_414_referme_le_paiement_et_la_securite(self):
        """Le désaccord exact du run `s3-back-office-paiements-20260825-101849`.

        La variable portait la liste des périmètres **retenus** exportée comme
        celle des périmètres **autorisés** — une inversion de sens qui ouvrait
        tout. L'intention, elle, n'en armait aucun.
        """
        self.arme([])
        retenus, erreurs = self.scopes(",".join(sorted(pr_gate.SCOPE_KEYS)))
        self.assertEqual(retenus, set())
        # Et le refus tombe bien là où il compte : sur la frontière PCI.
        self.assertEqual(
            pr_gate.blocking(["label mod:payments", "label security"], retenus),
            ["label mod:payments", "label security"])
        self.assertIn("ERROR", erreurs)

    def test_le_desaccord_nomme_les_perimetres_revoques(self):
        """« 2 périmètres » ne répond pas à « qu'est-ce qui a failli passer »."""
        self.arme(["prisma"])
        retenus, erreurs = self.scopes("prisma,mod:payments,security")
        self.assertEqual(retenus, {"prisma"})
        self.assertIn("mod:payments", erreurs)
        self.assertIn("security", erreurs)
        # Ce que l'armement a réellement donné est nommé lui aussi : sans cela,
        # le journal dit ce qui a été refusé sans dire au nom de quoi.
        self.assertIn("prisma", erreurs)

    def test_le_desaccord_est_journalise_en_error(self):
        self.arme([])
        _, erreurs = self.scopes("prisma")
        self.assertTrue(erreurs.lstrip().startswith("ERROR"),
                        "le désaccord doit se lire comme une erreur : " + erreurs)

    def test_all_dans_la_variable_ne_force_plus_rien(self):
        """`all` est un raccourci de saisie, pas un passe-droit.

        C'est la forme par laquelle le défaut est né : l'armement de 03h03 avait
        `--merge-sensitive all`, et sa vague a survécu au réarmement de 03h48.
        """
        self.arme(["infra/terraform"])
        retenus, erreurs = self.scopes(pr_gate.ALL_SCOPES)
        self.assertEqual(retenus, {"infra/terraform"})
        self.assertIn("ERROR", erreurs)

    # --- accord : rien ne change ------------------------------------------

    def test_l_armement_legitime_continue_de_merger(self):
        """`--merge-sensitive infra/terraform,prisma` armé et concordant.

        Le cas que la correction ne doit surtout pas casser : l'opérateur a
        donné son accord, l'intention et la variable disent la même chose, le
        merge se poursuit et personne n'est averti de rien.
        """
        self.arme(["infra/terraform", "prisma"])
        retenus, erreurs = self.scopes("infra/terraform,prisma")
        self.assertEqual(retenus, {"infra/terraform", "prisma"})
        self.assertEqual(erreurs, "")
        self.assertEqual(pr_gate.blocking(
            ["infra/terraform", "schéma ou migration Prisma"], retenus), [])

    def test_all_dans_l_intention_ouvre_tout_au_lieu_de_tout_fermer(self):
        """Les deux côtés doivent entendre `all` de la même façon.

        `milestone_supervise` développe le raccourci avant d'écrire, mais une
        intention posée à la main en porterait la forme brute. L'intersecter
        telle quelle ne garderait aucun périmètre — le contresens exact d'un
        raccourci qui les prend tous.
        """
        self.arme([pr_gate.ALL_SCOPES])
        retenus, erreurs = self.scopes("prisma")
        self.assertEqual(retenus, {"prisma"})
        self.assertEqual(erreurs, "")

    def test_accord_sur_aucun_perimetre(self):
        """Le cas le plus courant : rien d'armé, rien dans la variable."""
        self.arme([])
        self.assertEqual(self.scopes(""), (set(), ""))

    def test_la_variable_plus_stricte_que_l_intention_ne_declenche_rien(self):
        """Réarmer *plus large* pendant qu'une vague vole n'ouvre rien de neuf.

        C'est le sens inverse du défaut, et il est sans danger : la vague reste
        sur le périmètre étroit qu'elle a reçu. Rien n'est révoqué, donc rien
        n'est à signaler — un `ERROR` ici ne serait que du bruit.
        """
        self.arme(["infra/terraform", "prisma", "mod:payments"])
        self.assertEqual(self.scopes("prisma"), ({"prisma"}, ""))

    # --- ce qui n'est pas une intention -----------------------------------

    def test_intention_absente_laisse_la_variable_intacte(self):
        """`--no-watchdog` n'écrit aucune intention mais arme bien ses vagues.

        Durcir sur cette absence retirerait à l'opérateur une autorisation qu'il
        a réellement donnée : la correction deviendrait la panne.
        """
        self.assertFalse(self.intention.exists())
        self.assertEqual(self.scopes("infra/terraform"),
                         ({"infra/terraform"}, ""))

    def test_intention_illisible_laisse_la_variable_intacte(self):
        for contenu in ("{ pas du json", "[]", '{"merge_sensitive": "prisma"}'):
            with self.subTest(contenu=contenu):
                self.intention.write_text(contenu, encoding="utf-8")
                self.assertEqual(self.scopes("prisma"), ({"prisma"}, ""))

    # --- le mandat de l'arbitre n'est pas rogné ---------------------------

    def test_le_drapeau_de_l_arbitre_survit_a_l_intention(self):
        """`--merge-sensitive` sur l'appel est un mandat donné **maintenant**.

        L'arbitre l'a posé après avoir lu le diff et publié sa revue ; la
        variable, elle, n'est qu'un souvenir d'un armement passé. Confronter le
        drapeau à l'intention retirerait à l'arbitre le pouvoir que l'opérateur
        lui a explicitement confié.
        """
        self.arme([])
        retenus, _ = self.scopes("", extra="infra/terraform")
        self.assertEqual(retenus, {"infra/terraform"})

    def test_le_drapeau_ne_rattrape_que_ce_qu_il_nomme(self):
        self.arme([])
        retenus, erreurs = self.scopes("mod:payments,prisma", extra="prisma")
        self.assertEqual(retenus, {"prisma"})
        self.assertIn("mod:payments", erreurs)

    # --- la lecture doit viser le bon fichier ------------------------------

    def test_le_chemin_est_celui_qu_ecrit_le_superviseur(self):
        """Un fichier d'intention renommé rendrait la confrontation muette.

        `intent_scopes()` ne peut pas distinguer « le superviseur n'a rien armé »
        de « je ne lis pas le bon fichier » : les deux rendent `None`, et la
        barrière retomberait alors dans le défaut #414 sans un mot. Ce que le
        superviseur écrit fait foi, et c'est relu chez lui plutôt que recopié.
        """
        chemin = str(Path(pr_gate.__file__).resolve().parent)
        sys.path.insert(0, chemin)
        # Retiré derrière soi : laisser `scripts/` en tête de `sys.path` ferait
        # que les tests suivants importent depuis le dépôt plutôt que depuis ce
        # qu'ils ont préparé — une contagion qui ne se voit qu'à l'ordre des
        # tests.
        self.addCleanup(lambda: chemin in sys.path and sys.path.remove(chemin))
        import milestone_supervise  # noqa: E402 — après l'insertion de chemin

        self.assertEqual(pr_gate.INTENT_RELPATH[-1], milestone_supervise.INTENT.name)
        self.assertEqual(pr_gate.INTENT_RELPATH[-2],
                         milestone_supervise.INTENT.parent.name)
        # Et la clé lue est bien celle que l'armement écrit.
        self.assertIn(pr_gate.INTENT_KEY,
                      inspect.getsource(milestone_supervise.intent_of))

    def test_l_intention_est_cherchee_dans_le_depot_principal(self):
        """Les agents tournent en worktree, où `.claude/.milestone/` n'existe pas.

        Le dossier est ignoré par git : le chercher sous la racine du worktree
        n'y trouverait que l'absence, donc « rien à confronter » — et la
        confrontation serait muette précisément sous `/milestone`, le seul
        contexte où `SPA_UNATTENDED` est posée.
        """
        self.assertEqual((pr_gate.main_root() / ".claude").is_dir(), True)


class TestBlocking(unittest.TestCase):
    """`blocking()` — ce qui reste à relire une fois les autorisations défalquées."""

    def test_sans_autorisation_tout_bloque(self):
        """Le comportement d'avant #156, et le défaut d'aujourd'hui."""
        reasons = ["label mod:payments", "infra/terraform",
                   "schéma ou migration Prisma"]
        self.assertEqual(pr_gate.blocking(reasons, set()), reasons)

    def test_le_perimetre_autorise_ne_bloque_plus(self):
        self.assertEqual(
            pr_gate.blocking(["infra/terraform"], {"infra/terraform"}), [])

    def test_autorisation_nommee_n_ouvre_que_ce_qu_elle_nomme(self):
        """Le cœur de l'arbitrage : ouvrir le socle sans ouvrir le paiement."""
        reasons = ["label mod:payments", "infra/terraform"]
        self.assertEqual(pr_gate.blocking(reasons, {"infra/terraform"}),
                         ["label mod:payments"])

    def test_tout_autorise_ne_bloque_rien(self):
        reasons = ["label mod:payments", "label security", "infra/terraform",
                   "apps/api/src/modules/payments", "schéma ou migration Prisma"]
        self.assertEqual(pr_gate.blocking(reasons, set(pr_gate.SCOPE_KEYS)), [])

    def test_pr_anodine_ne_bloque_pas(self):
        self.assertEqual(pr_gate.blocking([], set()), [])

    # --- l'ignorance ne se pré-autorise pas -------------------------------

    def test_fichiers_indisponibles_bloquent_meme_tout_autorise(self):
        """« Ne pas savoir vaut refus » survit à la pré-autorisation.

        L'opérateur a autorisé un périmètre **nommé** ; il n'a pas autorisé un
        périmètre inconnu. Laisser `all` couvrir l'ignorance rendrait le
        garde-fou muet précisément les jours de forte charge, quand `gh` est en
        limite de débit — c'est-à-dire le trou que #121 avait bouché.
        """
        self.assertEqual(
            pr_gate.blocking(["liste des fichiers indisponible"],
                             set(pr_gate.SCOPE_KEYS)),
            ["liste des fichiers indisponible"])

    def test_labels_indisponibles_bloquent_meme_tout_autorise(self):
        self.assertEqual(
            pr_gate.blocking(["labels de l'issue indisponibles"],
                             set(pr_gate.SCOPE_KEYS)),
            ["labels de l'issue indisponibles"])

    def test_un_motif_connu_autorise_ne_sauve_pas_un_motif_ignore(self):
        self.assertEqual(
            pr_gate.blocking(["label security", "liste des fichiers indisponible"],
                             set(pr_gate.SCOPE_KEYS)),
            ["liste des fichiers indisponible"])


class TestSensitiveKeys(unittest.TestCase):
    """`SENSITIVE_KEYS` — chaque motif refusable doit avoir une clé, ou aucune.

    Un motif que `sensitive()` sait produire mais que `SENSITIVE_KEYS` ignore est
    un périmètre impossible à pré-autoriser : l'opérateur le nommerait dans son
    armement sans que rien ne s'ouvre, et il ne l'apprendrait qu'en relisant un
    journal, des heures plus tard.
    """

    def reasons(self, pr, paths, from_issue=frozenset()):
        with mock.patch.object(pr_gate, "issue_labels", return_value=from_issue):
            return pr_gate.sensitive(pr, paths)

    def test_chaque_motif_reel_a_une_cle(self):
        paths = ["infra/terraform/prod/main.tf",
                 "apps/api/src/modules/payments/refund.service.ts",
                 "apps/api/prisma/schema.prisma"]
        produced = self.reasons(pr_stub(), paths, set(pr_gate.SENSITIVE_LABELS))
        # Le jeu ci-dessus couvre bien tous les périmètres, sans quoi le test
        # passerait en n'en vérifiant qu'une partie.
        self.assertEqual(len(produced), len(pr_gate.SCOPE_KEYS))
        for reason in produced:
            with self.subTest(motif=reason):
                self.assertIn(reason, pr_gate.SENSITIVE_KEYS)

    def test_les_motifs_d_ignorance_n_ont_pas_de_cle(self):
        for reason in ("liste des fichiers indisponible",
                       "labels de l'issue indisponibles"):
            with self.subTest(motif=reason):
                self.assertNotIn(reason, pr_gate.SENSITIVE_KEYS)

    def test_aucune_cle_en_trop(self):
        """Une clé qui ne correspond à aucun motif serait une autorisation qui
        n'autorise rien — annoncée à l'opérateur dans l'aide de l'armement."""
        self.assertEqual(len(pr_gate.SCOPE_KEYS), len(pr_gate.SENSITIVE_KEYS))
        self.assertEqual(
            len(pr_gate.SCOPE_KEYS),
            len(pr_gate.SENSITIVE_LABELS) + len(pr_gate.SENSITIVE_PREFIXES) + 1)


class TestSensitiveScopes(unittest.TestCase):
    """`SENSITIVE_SCOPES` — le message d'armement doit décrire les vrais refus.

    Une liste recopiée à la main finit par décrire autre chose que ce que la
    barrière refuse, et c'est le message que l'opérateur ne peut pas vérifier :
    il est lu à l'instant où il cesse de regarder.
    """

    def test_chaque_perimetre_est_annonce(self):
        for name in pr_gate.SENSITIVE_LABELS:
            self.assertIn("label " + name, pr_gate.SENSITIVE_SCOPES)
        for prefix in pr_gate.SENSITIVE_PREFIXES:
            self.assertIn(prefix.rstrip("/"), pr_gate.SENSITIVE_SCOPES)
        self.assertIn("Prisma", pr_gate.SENSITIVE_SCOPES)

    def test_rien_de_plus_que_ce_qui_est_refuse(self):
        annonces = pr_gate.SENSITIVE_SCOPES.split(", ")
        self.assertEqual(
            len(annonces),
            len(pr_gate.SENSITIVE_LABELS) + len(pr_gate.SENSITIVE_PREFIXES) + 1)


if __name__ == "__main__":
    unittest.main()
