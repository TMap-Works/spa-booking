#!/usr/bin/env python3
"""Tests du ramasse-miettes de worktrees — `scripts/worktree_gc.py`.

    python -m unittest discover -s scripts/tests    # depuis la racine du dépôt
    npm run test:scripts                            # le même, par npm

Pourquoi ces fonctions et pas d'autres : le script a laissé s'accumuler 1,9 Go
dans `.claude/worktrees/` (#173), par trois défauts qui n'avaient en commun que
d'être invisibles.

1. **Ce qu'il ne regarde pas.** Il n'itérait que sur `git worktree list`. Or
   `git worktree remove` supprime l'entrée d'administration *même quand la
   suppression du répertoire échoue* — le cas courant sous Windows sur un
   `node_modules` verrouillé. Quatorze répertoires étaient ainsi devenus
   invisibles de tout le monde, pour 1,0 Go.
2. **Ce qu'il refuse de lâcher.** Le garde-fou « worktree sale » n'avait aucune
   exception : un `grep.exe.stackdump` retenait 126 Mo et un `package-lock.json`
   réécrit par npm 358 Mo, derrière des PR pourtant mergées.
3. **Ce qu'il pourrait détruire.** La correction du premier défaut lui donne le
   droit de supprimer des arbres entiers. Sous Windows, `os.path.islink` ne voit
   pas les jonctions NTFS avant Python 3.12 : suivre celle que pose le réglage
   `worktree.symlinkDirectories` viderait le `node_modules` du dépôt principal.

Le troisième est le seul dont une régression coûterait plus cher que le bug
d'origine — d'où un test qui manipule un vrai lien sur un vrai disque, et non
un double.

Aucune dépendance : `unittest` de la bibliothèque standard, comme les autres
harnais de `scripts/tests`.
"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

# `scripts/` n'est pas un paquet : c'est un dossier d'exécutables. On l'ajoute au
# chemin plutôt que d'y semer des `__init__.py` qui changeraient la façon dont
# les scripts eux-mêmes s'importent.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import worktree_gc as gc  # noqa: E402 — l'insertion de chemin doit la précéder


def completed(returncode=0, stdout="", stderr=""):
    """Une réponse de sous-processus, telle que `gc.run` en rend."""
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


def porcelain(*entries):
    """Sortie de `git status --porcelain -z` : champs collés, séparés par NUL."""
    return "".join(entry + chr(0) for entry in entries)


def entry(path="/tmp/wt", branch="feature/42-x", detached=False, locked=False):
    return {"path": path, "branch": branch, "detached": detached, "locked": locked}


def make_link(link, target):
    """Un lien de répertoire, par symlink ou à défaut par jonction NTFS.

    Créer un lien symbolique demande un privilège que Windows n'accorde pas par
    défaut ; la jonction, elle, ne demande rien. C'est d'ailleurs ce qui rend le
    cas réel : sur ce poste, c'est la jonction qu'on rencontre.
    """
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except (OSError, NotImplementedError, AttributeError):
        pass
    if os.name == "nt":
        done = subprocess.call(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return done == 0
    return False


class TestResidue(unittest.TestCase):
    """Distinguer ce que l'outillage laisse tomber de ce qu'un humain a écrit."""

    def test_reconnait_les_residus_qui_ont_retenu_484_mo(self):
        for name in ("grep.exe.stackdump", "package-lock.json", ".npmrc",
                     "npm-debug.log.2026", "apps/api/tsconfig.tsbuildinfo",
                     "packages/shared/package-lock.json"):
            self.assertTrue(gc.residue(name), name)

    def test_ne_prend_pas_du_travail_pour_un_residu(self):
        for name in ("apps/api/src/modules/payments/stripe.service.ts",
                     "prisma/schema.prisma", "infra/terraform/main.tf",
                     "package.json", "docs/adr/0007-verrous.md"):
            self.assertFalse(gc.residue(name), name)


class TestDirt(unittest.TestCase):
    """Lire `git status` sans se faire piéger par les noms de fichiers."""

    def read(self, stdout, returncode=0):
        with mock.patch.object(gc, "run", return_value=completed(returncode, stdout)):
            return gc.dirt("/tmp/wt")

    def test_lit_modifications_et_fichiers_non_suivis(self):
        self.assertEqual(
            self.read(porcelain(" M package-lock.json", "?? grep.exe.stackdump")),
            [(" M", "package-lock.json"), ("??", "grep.exe.stackdump")])

    def test_saute_l_ancien_chemin_d_un_renommage(self):
        # Un renommage occupe deux champs : le nouveau chemin, puis l'ancien.
        # Les compter tous les deux ferait passer l'ancien pour un fichier sale.
        self.assertEqual(
            self.read(porcelain("R  apps/b.ts", "apps/a.ts", " M package.json")),
            [("R ", "apps/b.ts"), (" M", "package.json")])

    def test_rend_le_nom_accentue_tel_quel(self):
        # `-z` justement pour ça : la forme lisible rendrait "docs/caf\303\251.md"
        # entre guillemets et échappé, et c'est sur ce nom que se décide la suite.
        self.assertEqual(self.read(porcelain("?? docs/café été.md")),
                         [("??", "docs/café été.md")])

    def test_git_muet_ne_fabrique_pas_de_salete(self):
        self.assertEqual(self.read("fatal: not a git repository", returncode=128), [])


class TestSafetyHold(unittest.TestCase):
    """Le garde-fou qui a retenu 484 Mo derrière deux PR mergées."""

    MERGED = "PR #145 mergée"
    CLOSED = "issue #145 fermée"

    def hold(self, reason, changes, ahead=0, force=False):
        with mock.patch.object(gc, "dirt", return_value=changes), \
             mock.patch.object(gc, "unpushed", return_value=ahead):
            return gc.safety_hold("/repo", entry(), reason, force)

    def test_pr_mergee_ne_reste_pas_derriere_un_vidage_de_crash(self):
        self.assertIsNone(self.hold(self.MERGED, [("??", "grep.exe.stackdump")]))

    def test_pr_mergee_ne_reste_pas_derriere_un_lockfile_reecrit_par_npm(self):
        self.assertIsNone(self.hold(self.MERGED, [(" M", "package-lock.json")]))

    def test_pr_mergee_conserve_quand_meme_du_vrai_travail(self):
        held = self.hold(self.MERGED, [(" M", "apps/api/src/x.ts"),
                                       ("??", "grep.exe.stackdump")])
        self.assertIsNotNone(held)
        self.assertIn("apps/api/src/x.ts", held)
        # Le résidu n'est pas ce qui retient : il n'a pas à être nommé.
        self.assertNotIn("stackdump", held)

    def test_sans_preuve_d_integration_le_moindre_residu_retient(self):
        # Le ticket n'est pas fini : rien ne dit que ce répertoire est jetable.
        held = self.hold(self.CLOSED, [("??", "grep.exe.stackdump")])
        self.assertIsNotNone(held)
        self.assertIn("stackdump", held)

    def test_branche_integree_vaut_preuve_au_meme_titre(self):
        self.assertIsNone(
            self.hold("branche déjà intégrée dans origin/develop",
                      [(" M", "package-lock.json")]))

    def test_commits_jamais_pousses_retiennent_hors_integration(self):
        held = self.hold(self.CLOSED, [], ahead=3)
        self.assertIsNotNone(held)
        self.assertIn("3", held)

    def test_squash_merge_ne_bloque_pas_sur_ses_propres_commits(self):
        # Un merge en squash laisse des commits locaux sans jumeau dans develop.
        self.assertIsNone(self.hold(self.MERGED, [], ahead=3))

    def test_force_leve_tout(self):
        self.assertIsNone(
            self.hold(self.CLOSED, [(" M", "apps/api/src/x.ts")], ahead=9, force=True))

    def test_nomme_au_plus_trois_fichiers(self):
        changes = [(" M", "f{}.ts".format(i)) for i in range(7)]
        held = self.hold(self.MERGED, changes)
        self.assertIn("f0.ts, f1.ts, f2.ts +4", held)


class TestVerdict(unittest.TestCase):
    """Un worktree verrouillé est un worktree occupé, quoi que dise GitHub."""

    def test_verrou_prime_sur_une_pr_mergee(self):
        prs = {"feature/42-x": {"number": 145, "state": "MERGED"}}
        action, reason, number = gc.verdict("/repo", entry(locked=True), prs, {})
        self.assertEqual(action, "keep")
        self.assertIn("verrouillé", reason)
        self.assertEqual(number, 42)

    def test_sans_verrou_la_pr_mergee_emporte_la_decision(self):
        prs = {"feature/42-x": {"number": 145, "state": "MERGED"}}
        with mock.patch.object(gc, "is_ancestor", return_value=False):
            action, reason, _ = gc.verdict("/repo", entry(), prs, {})
        self.assertEqual(action, "remove")
        self.assertIn("#145", reason)

    def test_branche_protegee_n_est_jamais_touchee(self):
        action, _, _ = gc.verdict("/repo", entry(branch="develop"), {}, {})
        self.assertEqual(action, "keep")


class TestListWorktrees(unittest.TestCase):
    """L'état verrouillé doit survivre à la lecture du porcelain."""

    def test_lit_le_verrou(self):
        stdout = ("worktree /repo\nbranch refs/heads/develop\n\n"
                  "worktree /repo/.claude/worktrees/a\n"
                  "branch refs/heads/bugfix/134-x\nlocked\n\n")
        with mock.patch.object(gc, "run", return_value=completed(0, stdout)):
            entries = gc.list_worktrees("/repo")
        self.assertEqual(len(entries), 2)
        self.assertFalse(entries[0]["locked"])
        self.assertTrue(entries[1]["locked"])
        self.assertEqual(entries[1]["branch"], "bugfix/134-x")


class TestRemoveForcesGit(unittest.TestCase):
    """Sans `--force`, git refusait tout worktree portant un fichier non suivi."""

    def test_force_est_systematique(self):
        calls = []

        def fake(args, cwd=None, timeout=30):
            calls.append(list(args))
            return completed(0)

        with mock.patch.object(gc, "run", side_effect=fake):
            self.assertIsNone(gc.remove("/repo", entry()))
        self.assertIn("--force", calls[0])
        self.assertEqual(calls[0][:4], ["git", "worktree", "remove", "--force"])


class TestFilesystem(unittest.TestCase):
    """Suppression réelle : c'est ici que se joue le risque de la correction."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="wgc-"))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_ne_traverse_jamais_un_lien_de_repertoire(self):
        # Le scénario redouté : `node_modules` du worktree est un lien vers celui
        # du dépôt principal. Supprimer le worktree ne doit vider que le lien.
        outside = self.root / "depot" / "node_modules"
        outside.mkdir(parents=True)
        (outside / "garde.txt").write_text("à ne pas perdre", encoding="utf-8")

        tree = self.root / "worktree"
        tree.mkdir()
        (tree / "README.md").write_text("x", encoding="utf-8")
        if not make_link(tree / "node_modules", outside):
            self.skipTest("ni lien symbolique ni jonction possible sur ce poste")

        self.assertTrue(gc.is_reparse(tree / "node_modules"))
        self.assertIsNone(gc.remove_tree(tree))
        self.assertFalse(tree.exists())
        self.assertTrue((outside / "garde.txt").exists())

    def test_supprime_un_arbre_imbrique_et_ses_fichiers_en_lecture_seule(self):
        deep = self.root / "wt" / "node_modules" / ".cache" / "a" / "b"
        deep.mkdir(parents=True)
        victim = deep / "readonly.bin"
        victim.write_bytes(b"npm pose parfois cet attribut")
        os.chmod(victim, stat.S_IREAD)

        self.assertIsNone(gc.remove_tree(self.root / "wt"))
        self.assertFalse((self.root / "wt").exists())

    def test_dir_size_ne_compte_pas_la_cible_d_un_lien(self):
        outside = self.root / "gros"
        outside.mkdir()
        (outside / "blob.bin").write_bytes(b"x" * 4096)

        tree = self.root / "wt"
        tree.mkdir()
        (tree / "petit.txt").write_bytes(b"y" * 10)
        if not make_link(tree / "node_modules", outside):
            self.skipTest("ni lien symbolique ni jonction possible sur ce poste")

        self.assertEqual(gc.dir_size(tree, time.monotonic() + 30), 10)

    def test_dir_size_rend_none_quand_le_temps_est_ecoule(self):
        (self.root / "wt").mkdir()
        self.assertIsNone(gc.dir_size(self.root / "wt", time.monotonic() - 1))

    def test_un_repertoire_qui_resiste_reste_lisible_au_passage_suivant(self):
        # `_drop` lève l'attribut lecture seule entre deux tours. S'il écrasait
        # le mode au lieu de l'enrichir, le répertoire deviendrait illisible
        # sous POSIX et plus aucun passage ne pourrait le parcourir.
        stuck = self.root / "wt" / "node_modules"
        stuck.mkdir(parents=True)
        (stuck / "reste.bin").write_bytes(b"locked")

        self.assertIsNotNone(gc._drop(gc.native(stuck), True))
        self.assertEqual([e.name for e in os.scandir(gc.native(stuck))],
                         ["reste.bin"])


class TestStrayDirs(unittest.TestCase):
    """Le balayage ne sort pas de `.claude/worktrees/` et ne suit aucun lien."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="wgc-"))
        self.base = self.root / gc.WORKTREE_DIR
        self.base.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def make(self, name):
        path = self.base / name
        path.mkdir()
        return path

    def test_ignore_ce_qu_un_worktree_vivant_revendique(self):
        vivant, orphelin = self.make("vivant"), self.make("orphelin")
        found = gc.stray_dirs(self.root, [str(self.root), str(vivant)])
        self.assertEqual([p.name for p in found], ["orphelin"])
        self.assertNotIn(vivant, found)

    def test_compare_les_chemins_sans_se_fier_a_leur_ecriture(self):
        # `git worktree list` rend des chemins à séparateurs POSIX sous Windows :
        # les comparer tels quels ferait passer un worktree vivant pour un vestige.
        vivant = self.make("vivant")
        claimed = str(vivant).replace(os.sep, "/")
        self.assertEqual(gc.stray_dirs(self.root, [claimed]), [])

    def test_n_emporte_pas_un_lien_pose_dans_le_dossier(self):
        ailleurs = self.root / "ailleurs"
        ailleurs.mkdir()
        if not make_link(self.base / "lien", ailleurs):
            self.skipTest("ni lien symbolique ni jonction possible sur ce poste")
        self.assertEqual(gc.stray_dirs(self.root, []), [])

    def test_ignore_les_fichiers(self):
        (self.base / "note.txt").write_text("x", encoding="utf-8")
        self.assertEqual(gc.stray_dirs(self.root, []), [])

    def test_dossier_absent_ne_leve_pas(self):
        self.assertEqual(gc.stray_dirs(self.root / "nulle-part", []), [])


class TestStrayVerdict(unittest.TestCase):
    """Sans git pour l'interroger, la preuve se cherche ailleurs."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="wgc-"))
        self.path = self.root / "orphelin"
        self.path.mkdir()
        self.now = time.time()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def verdict(self, attached=False, age=None, here=None):
        if age is not None:
            stamp = self.now - age
            os.utime(self.path, (stamp, stamp))
        with mock.patch.object(gc, "attached", return_value=attached):
            return gc.stray_verdict(self.root, self.path,
                                    here or (self.root / "ailleurs"), self.now)

    def test_repertoire_orphelin_et_rassis_est_supprimable(self):
        action, reason = self.verdict(age=gc.MIN_ORPHAN_AGE + 60)
        self.assertEqual(action, "remove")
        self.assertIn("orphelin", reason)

    def test_repertoire_tout_juste_cree_est_epargne(self):
        # Sous /milestone, plusieurs agents créent des worktrees de front : sans
        # ce délai, le nettoyage d'un run emporterait le worktree d'un autre.
        action, reason = self.verdict(age=5)
        self.assertEqual(action, "keep")
        self.assertIn("installation", reason)

    def test_worktree_git_encore_valide_est_epargne(self):
        action, reason = self.verdict(attached=True, age=gc.MIN_ORPHAN_AGE + 60)
        self.assertEqual(action, "keep")
        self.assertIn("repair", reason)

    def test_ne_scie_pas_la_branche_sur_laquelle_il_est_assis(self):
        action, reason = self.verdict(age=gc.MIN_ORPHAN_AGE + 60,
                                      here=self.path / "apps" / "api")
        self.assertEqual(action, "keep")
        self.assertIn("courant", reason)

    def test_repertoire_tout_juste_relache_par_git_ne_passe_pas_pour_neuf(self):
        # Ce que laisse un `git worktree remove` dont la suppression a échoué :
        # mtime de l'instant même. Sans l'exception, le garde-fou d'âge le
        # renverrait au passage suivant — et le recalcul ne servirait à rien.
        with mock.patch.object(gc, "attached", return_value=False):
            action, reason = gc.stray_verdict(
                self.root, self.path, self.root / "ailleurs", self.now,
                released=True)
        self.assertEqual(action, "remove")
        self.assertIn("tout juste supprimé", reason)


class TestHuman(unittest.TestCase):
    """Le chiffre qui manquait : 1,9 Go s'était accumulé sans que rien le dise."""

    def test_met_en_forme_a_la_francaise(self):
        self.assertEqual(gc.human(0), "0 o")
        self.assertEqual(gc.human(512), "512 o")
        self.assertEqual(gc.human(1024), "1,00 Ko")
        self.assertEqual(gc.human(1085276160), "1,01 Go")

    def test_absence_de_mesure_n_est_pas_zero(self):
        self.assertIsNone(gc.human(None))

    def test_total_ignore_les_mesures_manquantes(self):
        self.assertEqual(gc.total_bytes([{"bytes": 10}, {"bytes": None}, {}]), 10)

    def test_rien_de_mesure_ne_s_annonce_pas_comme_zero(self):
        # Un passage qui n'a supprimé que des branches, ou dont l'inventaire a
        # dépassé son budget, ne doit pas annoncer « 0 o récupéré ».
        self.assertIsNone(gc.measured([{"bytes": None}, {}]))
        self.assertIsNone(gc.measured([]))
        self.assertEqual(gc.measured([{"bytes": 10}, {"bytes": None}]), "10 o")


if __name__ == "__main__":
    unittest.main()
