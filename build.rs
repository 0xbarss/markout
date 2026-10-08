use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=web/dist/index.html");
    println!("cargo:rerun-if-env-changed=MARKOUT_SKIP_WEB");

    let dist_index = Path::new("web/dist/index.html");
    if dist_index.exists() {
        return;
    }

    if std::env::var("MARKOUT_SKIP_WEB").is_ok() {
        println!("cargo:warning=MARKOUT_SKIP_WEB is set; creating placeholder web/dist/index.html");
        std::fs::create_dir_all("web/dist").ok();
        std::fs::write(
            dist_index,
            "<!DOCTYPE html><html><head><title>Markout</title></head><body><div id=\"app\">Markout web interface placeholder (MARKOUT_SKIP_WEB=1)</div></body></html>",
        ).expect("failed to write placeholder index.html");
        return;
    }

    let npm_status = Command::new("npm")
        .args(["run", "build"])
        .current_dir("web")
        .status();

    match npm_status {
        Ok(status) if status.success() && dist_index.exists() => {
            println!("cargo:warning=Successfully built web assets via npm");
        }
        _ => {
            println!(
                "cargo:warning=web/dist/index.html missing. Run 'cd web && npm ci && npm run build' for the full UI."
            );
            std::fs::create_dir_all("web/dist").ok();
            std::fs::write(
                dist_index,
                "<!DOCTYPE html><html><head><title>Markout</title></head><body><div id=\"app\">Markout web interface placeholder (run 'npm run build' in web/)</div></body></html>",
            ).expect("failed to write placeholder index.html");
        }
    }
}
