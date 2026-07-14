// Prevent an extra console window on Windows in release. Harmless elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    seance_lib::run()
}
