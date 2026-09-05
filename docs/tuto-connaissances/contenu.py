"""Contenu des articles Connaissances pour sync-hub.

Séparé du script de publication : le texte se relit, se corrige et se rejoue sans toucher à la
mécanique d'API. Style maison Ekonum — bannières, sommaire, blocs repliables pour les questions
fréquentes, et on dit *où* se trouve chaque chose plutôt que de décrire une fonctionnalité.
"""

IMG = '<img src="{url}" class="img-fluid rounded img-thumbnail">'


def banner(kind, icon, html):
    """Bannière colorée : info, warning ou success."""
    return (
        f'<div data-oe-role="status" class="o_editor_banner user-select-none o-contenteditable-false '
        f'alert alert-{kind}" data-oe-protected="true" contenteditable="false">'
        f'<i class="o_editor_banner_icon mb-3 fst-normal">{icon}</i>'
        f'<div class="w-100 px-3" data-oe-protected="false" contenteditable="true">{html}</div>'
        f'</div>'
    )


def toggle(question, reponse):
    """Bloc repliable — la forme des questions fréquentes."""
    return (
        '<div data-embedded="toggleBlock" data-oe-protected="true" contenteditable="false" '
        'data-embedded-props=\'{"showContent": false}\'>'
        f'<div data-embedded-editable="title" data-oe-protected="false" contenteditable="true"><p>{question}</p></div>'
        f'<div data-embedded-editable="content" data-oe-protected="false" contenteditable="true">{reponse}</div>'
        '</div>'
    )


def article(titre, corps, sommaire=True):
    toc = '<div data-embedded="tableOfContent"></div>' if sommaire else ''
    return f'<h1 class="oe-hint">{titre}</h1>{toc}{corps}'


# --------------------------------------------------------------------------------------------
# 1. Accueil de la rubrique
# --------------------------------------------------------------------------------------------

ACCUEIL = article(
    'Sync-hub',
    banner('info', '💡',
           "<p>Sync-hub rassemble, <b>mot pour mot</b>, tout ce que tu as échangé avec les IA — Claude Code, "
           "Codex, Antigravity, plus tes archives ChatGPT et Claude.ai — dans un seul endroit consultable "
           "et fouillable.</p>")
    + '<p>Cette rubrique explique comment l\'installer et s\'en servir au quotidien.</p>'
    + '<h2>Les articles</h2>'
    + '<ul>'
    + '<li><b>Sync-hub en deux minutes</b> — à quoi ça sert, et ce que ça ne fait pas.</li>'
    + '<li><b>Installer sync-hub sur son poste</b> — l\'installation et le rattachement au hub.</li>'
    + '<li><b>Retrouver les échanges d\'un sujet</b> — la recherche, et l\'accès depuis l\'IA elle-même.</li>'
    + '<li><b>Classer ses conversations par projet</b> — pour que chaque échange retombe au bon endroit.</li>'
    + '<li><b>Organiser les projets en catégories</b> — client, ekonum, perso.</li>'
    + '<li><b>Suivre son temps et ses coûts</b> — combien d\'heures et combien d\'euros, par projet.</li>'
    + '</ul>',
    sommaire=False,
)


# --------------------------------------------------------------------------------------------
# 2. En deux minutes
# --------------------------------------------------------------------------------------------

def deux_minutes(img):
    return article(
        'Sync-hub en deux minutes',
        '<h2>Le problème</h2>'
        '<p>On travaille avec plusieurs IA, sur plusieurs postes, et chacune garde son historique dans son '
        'coin. Trois semaines plus tard, on ne sait plus si le sujet a été traité dans Claude Code, dans '
        'Codex ou dans une conversation ChatGPT — et on recommence de zéro un travail déjà fait.</p>'
        '<h2>Ce que fait sync-hub</h2>'
        '<p>Un petit service tourne en fond sur ton poste, lit les fichiers que les IA écrivent déjà, et les '
        'range dans une base unique. Un tableau de bord permet de tout relire et de tout fouiller.</p>'
        + IMG.format(url=img['01-vue-generale.png']) +
        '<h2>Ce qu\'il ne fait pas</h2>'
        '<ul>'
        '<li><b>Il ne résume rien.</b> Ce que tu relis est le texte exact, pas une reformulation.</li>'
        '<li><b>Il n\'écrit jamais dans les outils.</b> Il lit ; il ne modifie pas tes conversations Claude '
        'ou Codex.</li>'
        '<li><b>Il ne devine pas.</b> Un projet, une catégorie, un coût : rien n\'est inventé. Quand '
        'l\'information n\'existe pas, elle est annoncée comme absente plutôt que comblée.</li>'
        '</ul>'
        + banner('warning', '⚠️',
                 "<p>Tes conversations contiennent des informations clients. Elles restent sur ton poste et "
                 "sur le hub interne Ekonum : rien n'est envoyé ailleurs.</p>")
        + '<h2>Questions fréquentes</h2>'
        + toggle("Est-ce que ça ralentit mon poste ?",
                 "<p>Non. Le service consomme quelques pourcents d'un cœur au repos. Il lit des fichiers "
                 "que les outils écrivent de toute façon.</p>")
        + toggle("Est-ce que mes collègues voient mes conversations ?",
                 "<p>Non, pas par défaut. Chaque projet appartient à la personne qui l'a poussé, et reste "
                 "invisible aux autres tant qu'elle ne l'a pas partagé explicitement.</p>")
        + toggle("Et si je travaille sur deux postes ?",
                 "<p>Chaque poste s'enrôle séparément et pousse vers le même hub. Tu retrouves l'ensemble "
                 "depuis n'importe lequel, et depuis le hub en ligne.</p>"),
    )


# --------------------------------------------------------------------------------------------
# 3. Installation
# --------------------------------------------------------------------------------------------

def installation(img):
    return article(
        'Installer sync-hub sur son poste',
        banner('info', '💡', "<p>Compte 10 minutes. Le premier scan de l'historique peut tourner "
                             "plusieurs minutes en arrière-plan : le tableau de bord est utilisable "
                             "pendant ce temps.</p>")
        + '<h2>1. Récupérer et installer</h2>'
        '<pre><code>git clone https://github.com/robjo82/sync-hub.git\n'
        'cd sync-hub\n'
        'npm install\n'
        './scripts/install_service.sh</code></pre>'
        '<p>Le script installe un service qui démarre à l\'ouverture de session et redémarre tout seul. '
        'Le tableau de bord est ensuite sur <code>http://127.0.0.1:4000</code>.</p>'
        '<h2>2. Rattacher le poste au hub</h2>'
        '<p>Sans cette étape, tes conversations restent <b>uniquement en local</b> : elles ne sont pas '
        'sauvegardées et tu ne les retrouveras pas depuis un autre poste.</p>'
        '<ol>'
        '<li>Sur ton poste : <code>./scripts/enroll.sh</code>. Il fabrique un jeton qui '
        '<b>ne quitte jamais ta machine</b> et affiche son empreinte.</li>'
        '<li>Ouvre le hub : <code>https://sync-hub.robin-joseph.fr</code>, et connecte-toi.</li>'
        '<li>Menu de ton compte, en haut à droite → <b>Mon compte</b>.</li>'
        '<li>Section <b>Appareils</b> → <b>Approuver un appareil</b> : colle l\'empreinte et '
        'nomme la machine.</li>'
        '</ol>'
        + banner('info', '💡',
                 "<p>L'empreinte <b>n'est pas un secret</b> : elle n'autorise rien et peut être "
                 "collée dans un message sans précaution. C'est le jeton, resté sur ta machine, qui "
                 "authentifie — et il n'a jamais eu à voyager.</p>")
        + banner('warning', '⚠️',
                 "<p>Un jeton par machine. C'est ce qui permet de révoquer un portable perdu sans couper "
                 "tout le monde.</p>")
        + '<h2>3. Déposer ses archives ChatGPT et Claude.ai</h2>'
        '<p>Les conversations web ne sont pas lisibles depuis ton disque : il faut les exporter une fois.</p>'
        '<ul>'
        '<li><b>ChatGPT</b> : Réglages → Contrôles des données → Exporter. Tu reçois un zip par courriel.</li>'
        '<li><b>Claude.ai</b> : Settings → Privacy → Export data.</li>'
        '</ul>'
        '<p>Dépose ensuite le zip dans l\'onglet <b>Appareils</b> du tableau de bord, zone d\'import.</p>'
        + '<h2>Questions fréquentes</h2>'
        + toggle("Le tableau de bord est vide après l'installation",
                 "<p>Le premier scan tourne en arrière-plan et peut prendre plusieurs minutes sur un gros "
                 "historique. L'arbre se remplit au fur et à mesure ; recharge la page après une minute ou deux.</p>")
        + toggle("J'ai perdu mon jeton d'appareil",
                 "<p>Il n'est pas récupérable, par conception. Révoque-le depuis <b>Mon compte</b>, puis "
                 "relance <code>./scripts/enroll.sh</code> sur la machine et approuve la nouvelle "
                 "empreinte.</p>")
        + toggle("Comment savoir si mon poste est bien rattaché ?",
                 "<p>En haut du tableau de bord, l'indicateur affiche « Cet appareil ». Ouvre <b>Mon compte</b> : "
                 "la ligne sous ton nom dit vers quel hub la machine pousse, ou qu'elle ne pousse nulle part.</p>"),
    )


# --------------------------------------------------------------------------------------------
# 4. Retrouver un sujet
# --------------------------------------------------------------------------------------------

def recherche(img):
    return article(
        "Retrouver les échanges d'un sujet",
        "<p>C'est l'usage principal : savoir ce qui a déjà été dit sur un sujet, quel que soit l'outil dans "
        "lequel ça s'est passé.</p>"
        '<h2>Depuis le tableau de bord</h2>'
        "<p>Onglet <b>Recherche</b>, en haut. Tape ce que tu cherches : la recherche porte sur le texte "
        "exact de tous les messages, tous outils et tous projets confondus.</p>"
        + IMG.format(url=img['03-recherche.png']) +
        "<p>Chaque résultat indique le projet, le titre du fil, l'outil et la date. Un clic ouvre la "
        "conversation à l'endroit trouvé.</p>"
        + banner('info', '💡',
                 "<p>La recherche est <b>littérale</b> : elle cherche la chaîne que tu tapes, accents "
                 "ignorés. Si tu ne trouves pas, essaie un mot plus court ou un terme qui figurait "
                 "vraiment dans l'échange.</p>")
        + "<h2>Depuis l'IA elle-même</h2>"
        "<p>C'est le plus utile au quotidien : demander à l'assistant d'aller voir avant de repartir de "
        "zéro. Sync-hub expose un serveur MCP que Claude Code et Codex savent interroger.</p>"
        "<p>Concrètement, tu peux écrire :</p>"
        "<blockquote><p>Regarde dans sync-hub ce qu'on a déjà fait sur la migration Acritec avant de "
        "commencer.</p></blockquote>"
        "<p>L'assistant retrouve les échanges concernés, dans les autres outils compris, et te les cite "
        "verbatim.</p>"
        + '<h2>Questions fréquentes</h2>'
        + toggle("La recherche ne trouve rien alors que je suis sûr d'en avoir parlé",
                 "<p>Trois causes possibles : l'échange était sur un poste non encore rattaché ; il vient "
                 "d'une conversation web dont l'archive n'a pas été déposée ; ou le terme cherché n'était "
                 "pas écrit tel quel. Essaie un mot plus distinctif et plus court.</p>")
        + toggle("Puis-je chercher dans les conversations d'un collègue ?",
                 "<p>Seulement s'il t'a partagé le projet concerné. Sinon ses conversations ne "
                 "t'apparaissent pas, y compris en recherche.</p>"),
    )


# --------------------------------------------------------------------------------------------
# 5. Classer par projet
# --------------------------------------------------------------------------------------------

def projets(img):
    return article(
        'Classer ses conversations par projet',
        "<p>Sync-hub rattache automatiquement une conversation au projet correspondant quand il peut le "
        "déduire du dossier de travail. Le reste atterrit dans <b>Non affecté</b>, et c'est à toi de le "
        "ranger — l'outil ne devine pas.</p>"
        + banner('warning', '⚠️',
                 "<p>Ce classement conditionne tout le reste : le temps passé et les coûts sont calculés "
                 "<b>par projet</b>. Ce qui reste dans « Non affecté » n'est imputable à personne.</p>")
        + '<h2>Ranger ce qui traîne</h2>'
        '<ol>'
        "<li>Onglet <b>Non affecté</b> : le compteur à côté du nom indique combien de fils attendent.</li>"
        "<li>Pour chaque fil, choisis le projet de destination.</li>"
        '</ol>'
        '<h2>Agir sur un projet</h2>'
        "<p>Dans l'arbre de gauche, survole un projet : un bouton <b>⋯</b> apparaît à droite de son nom.</p>"
        + IMG.format(url=img['06-actions-projet.png']) +
        '<ul>'
        '<li><b>Renommer</b> — le nom affiché partout.</li>'
        '<li><b>Catégoriser</b> — voir l\'article suivant.</li>'
        '<li><b>Partager avec un collègue</b> — en lecture.</li>'
        '<li><b>Exporter</b> — Markdown ou JSON.</li>'
        '<li><b>Fusionner</b> — quand deux projets désignent le même travail.</li>'
        '<li><b>Archiver</b> et <b>Supprimer</b>, isolés en bas : les deux qu\'on ne défait pas facilement.</li>'
        '</ul>'
        '<h2>Renommer un fil mal nommé</h2>'
        "<p>Le titre d'un fil est déduit de son premier message. Quand la conversation commence par un "
        "bout de code ou un message technique, le titre est mauvais. Tu peux le remplacer en le demandant "
        "à l'assistant :</p>"
        "<blockquote><p>Dans sync-hub, renomme ce fil en « Reprise des contrats Acritec ».</p></blockquote>"
        "<p>Le nom choisi à la main n'est plus jamais réécrit par l'outil.</p>"
        + '<h2>Questions fréquentes</h2>'
        + toggle("Pourquoi certaines conversations arrivent-elles déjà classées ?",
                 "<p>Quand l'outil travaillait dans un dossier reconnu, le rattachement est déduit du "
                 "chemin. Les conversations web, elles, n'ont aucun chemin : elles arrivent toujours "
                 "dans « Non affecté ».</p>")
        + toggle("Supprimer un projet supprime-t-il mes fichiers ?",
                 "<p>La suppression déplace le dossier du projet vers la Corbeille — c'est la seule "
                 "action qui touche à des fichiers en dehors de sync-hub, et elle demande une confirmation "
                 "explicite. Si tu veux seulement le sortir de la liste, utilise <b>Archiver</b>.</p>"),
    )


# --------------------------------------------------------------------------------------------
# 6. Catégories
# --------------------------------------------------------------------------------------------

def categories(img):
    return article(
        'Organiser les projets en catégories',
        "<p>Les catégories regroupent les projets dans la colonne de gauche. Trois existent d'origine : "
        "<b>client</b>, <b>ekonum</b> et <b>perso</b>.</p>"
        + IMG.format(url=img['02-arbre-projets.png']) +
        '<h2>Attribuer une catégorie</h2>'
        "<p>Bouton <b>⋯</b> sur le projet → <b>Catégoriser</b>. Tu peux aussi le demander à l'assistant :</p>"
        "<blockquote><p>Dans sync-hub, classe le projet MGX Contrôle en catégorie client.</p></blockquote>"
        + banner('info', '💡',
                 "<p>Une catégorie posée à la main n'est jamais écrasée par un scan. Tu peux la changer "
                 "quand tu veux, rien ne la remettra en cause tout seul.</p>")
        + '<h2>À quoi ça sert</h2>'
        '<ul>'
        "<li>Retrouver un projet dans une liste qui en compte plusieurs dizaines.</li>"
        "<li>Filtrer le temps passé et les coûts sur une catégorie entière — par exemple tout le "
        "facturable client sur un mois.</li>"
        '</ul>'
        + '<h2>Questions fréquentes</h2>'
        + toggle("Puis-je créer mes propres catégories ?",
                 "<p>Oui. Saisis un nom qui n'existe pas encore dans le panneau <b>Catégoriser</b> : "
                 "il est créé au passage.</p>")
        + toggle("Un projet peut-il être dans deux catégories ?",
                 "<p>Non, une seule. C'est un rangement, pas un étiquetage.</p>"),
    )


# --------------------------------------------------------------------------------------------
# 7. Temps et coûts
# --------------------------------------------------------------------------------------------

def temps_couts(img):
    return article(
        'Suivre son temps et ses coûts',
        '<h2>Le temps passé</h2>'
        "<p>Onglet <b>Temps</b>. Deux chiffres, volontairement séparés parce qu'ils ne sont pas de même "
        "nature.</p>"
        + IMG.format(url=img['04-temps.png']) +
        '<ul>'
        "<li><b>Rédaction</b> — une <i>estimation</i> du temps passé à écrire, à partir d'un rythme de "
        "frappe. Le contenu collé (code, courriels cités) n'est pas compté, et un message n'est jamais "
        "compté plus longtemps que le temps réellement écoulé depuis le précédent.</li>"
        "<li><b>Réponse de l'IA</b> — <i>mesurée</i>, pas estimée : l'attente entre une question et sa "
        "réponse.</li>"
        '</ul>'
        + banner('info', '💡',
                 "<p>Le troisième encadré indique combien de messages ont vu leur estimation limitée par "
                 "le temps écoulé. Plus ce nombre est élevé, plus le total repose sur de l'observation "
                 "plutôt que sur un calcul théorique.</p>")
        + '<h2>Régler son rythme de frappe</h2>'
        "<p><b>Mon compte</b> → <b>Rythme de frappe</b>. La valeur par défaut est basse à dessein : elle "
        "sous-estime plutôt qu'elle ne surestime, ce qui est le bon sens quand le chiffre peut finir sur "
        "une facture.</p>"
        '<h2>Les coûts</h2>'
        "<p>Onglet <b>Coûts</b>. L'encadré <b>Provenance des chiffres</b> distingue trois niveaux, et "
        "c'est le point important :</p>"
        + IMG.format(url=img['05-couts.png']) +
        '<ul>'
        "<li><b>Mesuré</b> — consommation rapportée par l'outil, tarif publié par l'éditeur.</li>"
        "<li><b>Interpolé</b> — modèle sans tarif publié, taux déduit de ses deux voisins.</li>"
        "<li><b>Borne haute des archives</b> — un export ChatGPT ne dit pas quel modèle a répondu, donc "
        "le modèle le plus cher de l'époque est supposé. <b>Exclu du total</b>, affiché à part.</li>"
        '</ul>'
        + banner('warning', '⚠️',
                 "<p>Ces montants sont des équivalents API. Ils ne correspondent pas à ce qui est "
                 "réellement facturé sur un abonnement forfaitaire — c'est un ordre de grandeur de la "
                 "consommation, pas une facture.</p>")
        + '<h2>Questions fréquentes</h2>'
        + toggle("Mon temps est presque entièrement dans « Non affecté »",
                 "<p>C'est le cas au début pour tout le monde. Le temps est bien mesuré, mais il n'est "
                 "imputable qu'une fois les fils rattachés à un projet — voir « Classer ses conversations "
                 "par projet ».</p>")
        + toggle("Pourquoi le total de rédaction change quand je modifie le rythme de frappe ?",
                 "<p>Parce que c'est une estimation qui en dépend directement. Le temps de réponse de "
                 "l'IA, lui, ne bouge pas : il est mesuré.</p>")
        + toggle("Puis-je exporter ces chiffres ?",
                 "<p>Le bouton <b>Exporter</b> de l'onglet Coûts produit un fichier reprenant le détail "
                 "par modèle, par projet et par date.</p>"),
    )
