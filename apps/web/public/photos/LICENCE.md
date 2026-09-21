# Photographies d'ambiance — provenance et licence

Les huit fichiers de ce dossier viennent d'[Unsplash](https://unsplash.com). La
[licence Unsplash](https://unsplash.com/license) accorde un droit d'usage
gratuit, y compris commercial, avec droit de copier, modifier et distribuer les
images, **sans attribution obligatoire**. Elle interdit en revanche de les
revendre telles quelles et de bâtir avec elles un service concurrent d'Unsplash
— ni l'un ni l'autre n'est le cas ici.

L'attribution n'étant pas exigée, elle n'apparaît pas dans les pages. Elle est
consignée ici parce qu'une provenance qu'on ne peut plus retracer est une
licence qu'on ne peut plus défendre : le jour où l'une de ces images pose
question, la ligne ci-dessous dit d'où elle vient.

Chaque fichier a été téléchargé redimensionné et recompressé par le service
d'images d'Unsplash (`?w=<largeur>&q=72&fm=jpg&crop=entropy&fit=crop`), ce qui
explique que la source d'origine soit plus grande.

| Fichier | Sujet | Identifiant Unsplash | Dimensions |
|---|---|---|---|
| `spa-interieur.jpg` | Intérieur de spa, bassin et verdure | `photo-1560750588-73207b1ef5b8` | 1600 × 1281 |
| `soin-pierres-chaudes.jpg` | Soin aux pierres chaudes | `photo-1600334089648-b0d9d3028eb2` | 1400 × 933 |
| `massage-dos.jpg` | Massage du dos | `photo-1519823551278-64ac92734fb1` | 1100 × 1650 |
| `coiffure-brushing.jpg` | Brushing en salon | `photo-1562322140-8baeececf3df` | 1100 × 734 |
| `salon-interieur.jpg` | Postes de coiffage | `photo-1633681926022-84c23e8cb2d6` | 1200 × 800 |
| `soin-visage.jpg` | Soin du visage au pinceau | `photo-1570172619644-dfd03ed5d881` | 1000 × 667 |
| `nature-morte-spa.jpg` | Serviette, flacon et fleurs | `photo-1540555700478-4be289fbecef` | 1000 × 667 |
| `barbier.jpg` | Rasage chez le barbier | `photo-1532710093739-9470acff878f` | 1000 × 667 |

L'adresse d'origine d'une image se reconstitue en préfixant son identifiant :
`https://images.unsplash.com/<identifiant>`.

## Ajouter une photographie

1. La choisir sur Unsplash, et vérifier qu'elle montre bien l'un des quatre
   métiers du périmètre (CDC §1.1) : spa, institut de beauté, salon de coiffure,
   barbershop.
2. La télécharger à la largeur utile — pas davantage : ces fichiers sont
   versionnés, et une photo de 4000 px pèse dix fois ce qu'elle rend à l'écran.
3. L'inscrire dans le tableau ci-dessus **et** dans `apps/web/lib/photos.ts`,
   avec son texte alternatif. Une image que le registre ignore n'est employée
   nulle part.
