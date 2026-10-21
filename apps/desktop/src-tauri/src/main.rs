// Coquille native de NEXUS pour Windows.
//
// Ce fichier est la totalité du code qui tourne hors du bac à sable du moteur de
// rendu. Il est court, et c'est une décision : chaque commande exposée ici est
// une porte entre une page web et le système d'exploitation.
//
// Les six commandes ci-dessous sont l'intégralité de cette surface. On y
// cherchera en vain de quoi exécuter une commande, lancer un processus, ou lire
// un fichier arbitraire — l'interface n'exécute pas. Quand l'utilisateur demande
// à NEXUS d'agir sur ce poste, la demande part au cœur, qui autorise, choisit un
// exécutant, et redescend par le canal worker jusqu'au démon. Le démon est un
// autre processus, avec un autre secret, et cette fenêtre n'a aucune prise sur
// lui.
//
// AVERTISSEMENT : ce module n'a pas été compilé. La chaîne d'outils Rust n'est
// pas installée dans l'environnement où le reste du dépôt a été vérifié. Tout ce
// qui est au-dessus — interface, cœur client, protocole, API, exécutant — est
// éprouvé ; ceci ne l'est pas.

use std::fs;
use std::path::PathBuf;

use keyring::Entry;
use serde::Deserialize;
use tauri_plugin_notification::NotificationExt;

/// Service sous lequel les secrets sont rangés dans le trousseau du système —
/// Credential Manager sous Windows, Keychain sous macOS, Secret Service sous
/// Linux. Fixe : le moteur de rendu ne le choisit pas, sans
/// quoi une page compromise pourrait lire les secrets d'une autre application.
const KEYRING_SERVICE: &str = "fr.nexus.desktop";

/// Clés autorisées.
///
/// Liste blanche, et non validation de forme. Le moteur de rendu ne range que
/// trois choses ; accepter une clé arbitraire transformerait le trousseau de
/// l'utilisateur en espace de stockage libre pour du code web.
const ALLOWED_KEYS: [&str; 3] = ["nexus.access", "nexus.refresh", "nexus.device"];

fn check_key(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!("clé non autorisée : {key}"))
    }
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    check_key(&key)?;

    match Entry::new(KEYRING_SERVICE, &key).and_then(|entry| entry.get_password()) {
        Ok(value) => Ok(Some(value)),
        // Absent n'est pas une erreur : c'est le cas d'un premier démarrage.
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(cause) => Err(cause.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    check_key(&key)?;

    Entry::new(KEYRING_SERVICE, &key)
        .and_then(|entry| entry.set_password(&value))
        .map_err(|cause| cause.to_string())
}

#[tauri::command]
fn secret_remove(key: String) -> Result<(), String> {
    check_key(&key)?;

    match Entry::new(KEYRING_SERVICE, &key).and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(cause) => Err(cause.to_string()),
    }
}

#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|cause| cause.to_string())
}

/// État public du démon exécutant.
///
/// Seul `device_id` est lu. Le fichier peut contenir d'autres champs — chemin de
/// la clé, journal, réglages — et aucun ne remonte au moteur de rendu. La clé
/// privée elle-même vit dans un autre fichier, que cette coquille n'ouvre
/// jamais.
#[derive(Deserialize)]
struct WorkerState {
    #[serde(rename = "deviceId")]
    device_id: String,
}

fn worker_state_path() -> Option<PathBuf> {
    std::env::var_os("ProgramData")
        .map(|root| PathBuf::from(root).join("NEXUS").join("worker").join("device.json"))
}

/// Identifiant de l'exécutant installé sur cette machine.
///
/// Un identifiant, jamais un secret : il n'ouvre aucun droit. Il sert seulement
/// à ce que la fenêtre reconnaisse « cette machine » dans la liste d'appareils
/// que le cœur lui renvoie, et n'aille pas créer un second appareil fantôme pour
/// le même poste.
#[tauri::command]
fn local_worker_device_id() -> Option<String> {
    let path = worker_state_path()?;
    let contents = fs::read_to_string(path).ok()?;
    let state: WorkerState = serde_json::from_str(&contents).ok()?;

    if state.device_id.is_empty() {
        None
    } else {
        Some(state.device_id)
    }
}

#[tauri::command]
fn machine_name() -> String {
    std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Poste Windows".to_string())
}

/// Ouvre une URL dans le navigateur par défaut.
///
/// Le schéma est vérifié : `file:` ouvrirait un fichier local, et les schémas
/// exotiques enregistrés par d'autres applications sont autant de chemins
/// d'exécution indirects. Seuls `http` et `https` passent.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("seuls http et https sont autorisés".to_string());
    }

    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<String>)
        .map_err(|cause| cause.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_remove,
            notify,
            local_worker_device_id,
            machine_name,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("démarrage de la fenêtre NEXUS");
}
