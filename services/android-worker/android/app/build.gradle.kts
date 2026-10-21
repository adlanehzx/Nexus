plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.facebook.react")
}

/**
 * L'application worker.
 *
 * ## Les sources ne sont pas deplacees
 *
 * Le manifeste, le Kotlin et les ressources existaient avant ce projet Gradle,
 * a l'emplacement `android/src/main`. Plutot que de les deplacer vers la
 * disposition attendue par le greffon Android — ce qui aurait reecrit
 * l'historique de fichiers deja relus et testes — on pointe les `sourceSets`
 * dessus. Une declaration de six lignes vaut mieux qu'un deplacement de huit
 * fichiers.
 */
/**
 * Signature de publication, prise dans l'ENVIRONNEMENT.
 *
 * Quatre variables, et aucune dans le depot :
 *
 *   NEXUS_KEYSTORE_PATH      chemin du .jks
 *   NEXUS_KEYSTORE_PASSWORD  mot de passe du magasin
 *   NEXUS_KEY_ALIAS          alias de la cle
 *   NEXUS_KEY_PASSWORD       mot de passe de la cle
 *
 * Toutes presentes et le fichier lisible : l'APK est signe. Sinon il est produit
 * NON SIGNE, et le build le dit au lieu d'echouer.
 *
 * Ce choix merite sa raison. Echouer sans keystore rendrait la chaine
 * impossible a verifier : personne ne saurait si le build casse a cause du code
 * ou de l'absence de cle, et on ne l'apprendrait que le jour de la publication.
 * Produire un APK non signe prouve tout sauf la signature — un artefact qui
 * refuse de s'installer, ce qui est exactement ce qu'on veut d'un paquet sans
 * cle.
 *
 * Un keystore versionne serait l'inverse : n'importe qui pourrait publier une
 * mise a jour de cette application, sur un telephone qui detient un service
 * d'accessibilite.
 */
val keystorePath: String? = System.getenv("NEXUS_KEYSTORE_PATH")
val keystorePassword: String? = System.getenv("NEXUS_KEYSTORE_PASSWORD")
val keyAlias: String? = System.getenv("NEXUS_KEY_ALIAS")
val keyPassword: String? = System.getenv("NEXUS_KEY_PASSWORD")

val signingReady: Boolean =
    !keystorePath.isNullOrBlank() &&
        file(keystorePath).exists() &&
        !keystorePassword.isNullOrBlank() &&
        !keyAlias.isNullOrBlank() &&
        !keyPassword.isNullOrBlank()

gradle.taskGraph.whenReady {
    // Dit a la construction, pas apres : un APK non signe decouvert au moment de
    // l'installation coute un aller-retour complet.
    if (signingReady) {
        logger.lifecycle("NEXUS : APK de publication SIGNE (keystore fourni par l'environnement).")
    } else {
        logger.lifecycle("NEXUS : APK de publication NON SIGNE — aucun keystore dans l'environnement.")
    }
}

react {
    // Le paquet npm est le parent : c'est la que vivent `index.js`,
    // `nexus.config.json`, `metro.config.js` et le code TypeScript.
    root = file("../..")
    reactNativeDir = file("../../node_modules/react-native")
    // Chemin **absolu**, et c'est tout l'enjeu.
    //
    // Ecrit en relatif, il etait passe tel quel a `cmd`, qui le resolvait depuis
    // son propre repertoire de travail et non depuis celui du projet. Le binaire
    // existe pourtant : pnpm place `react-native` en lien symbolique sous
    // `services/android-worker/node_modules`, et non a la racine du depot ou
    // Gradle finissait par le chercher. Le build echouait alors juste apres avoir
    // ecrit le bundle, sur un « chemin d'acces introuvable » qui ne nommait rien.
    //
    // `%OS-BIN%` reste litteral : c'est le greffon React Native qui le remplace
    // par `win64-bin`, `osx-bin` ou `linux64-bin` selon la machine.
    hermesCommand = file("../../node_modules/react-native/sdks/hermesc")
        .absolutePath.replace("\\", "/") + "/%OS-BIN%/hermesc"
    codegenDir = file("../../node_modules/@react-native/codegen")

    entryFile = file("../../index.js")

    // L'autolinking n'est volontairement pas active : ce worker n'a aucune
    // dependance native tierce, et la liste des paquets est ecrite a la main
    // dans `NexusWorkerApplication`. Une bibliotheque native ne peut donc pas
    // s'inviter par transitivite sur un appareil qui detient un service
    // d'accessibilite.
}

android {
    namespace = "fr.nexus.worker"

    // React Native 0.81 est compile contre Android 16. `compileSdk` ne change
    // pas ce que l'application demande au systeme — c'est `targetSdk` qui le
    // fait — mais il doit couvrir les API que les dependances referencent.
    compileSdk = 36

    defaultConfig {
        applicationId = "fr.nexus.worker"

        // Android 11. C'est la version du Redmi Note 10S vise, et c'est aussi
        // le minimum de `AccessibilityService.takeScreenshot()` : sous cette
        // version, `android.ui.screenshot` n'est simplement pas annoncee.
        minSdk = 30
        targetSdk = 35

        versionCode = 1
        versionName = "0.1.0"

        ndk {
            // Les architectures reellement visees, lues depuis gradle.properties.
            abiFilters += (project.properties["reactNativeArchitectures"] as String)
                .split(",")
                .map { it.trim() }
        }
    }

    sourceSets {
        named("main") {
            manifest.srcFile("../AndroidManifest.xml")
            java.srcDirs("../src/main/kotlin")
            res.srcDirs("../src/main/res")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (signingReady) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
                // V1 reste active : un telephone sous Android 10 ou plus ancien
                // n'installe pas un APK signe uniquement en V2.
                enableV1Signing = true
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        getByName("debug") {
            // Signature de debogage par defaut d'Android. Aucun secret n'est
            // stocke dans le depot : la cle de publication est configuree hors
            // depot, au moment de la mise en production.
            isMinifyEnabled = false
        }

        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // Signe si et seulement si l'environnement fournit un keystore
            // complet et lisible. Sinon l'APK est produit non signe : un
            // artefact qui refuse de s'installer vaut mieux qu'une cle
            // versionnee.
            signingConfig = if (signingReady) signingConfigs.getByName("release") else null
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        jvmToolchain(17)
    }

    packaging {
        resources {
            excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
        }
    }
}

dependencies {
    // React Native : moteur JavaScript, pont natif, `ReactActivity`. Les
    // versions viennent du greffon, alignees sur le paquet npm.
    implementation("com.facebook.react:react-android")
    implementation("com.facebook.react:hermes-android")

    // `NotificationCompat`, `NotificationManagerCompat`, `Theme.AppCompat` —
    // utilises par le module natif existant, le service de premier plan et le
    // theme de l'activite.
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // Coroutines : `NexusWorkerModule` s'en sert pour la capture d'ecran, dont
    // l'API systeme est asynchrone a rappel.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
