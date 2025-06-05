import { App, Modal, Plugin, Setting, Notice, ButtonComponent,  } from 'obsidian';

import { createExpOpt } from './common';
import { AuthUI } from './auth_ui';
import { FlomoImporter } from '../flomo/importer';
import { FlomoExporter } from '../flomo/exporter';

import * as path from 'path';
import * as os from 'os';
import *  as fs from 'fs-extra';

import { AUTH_FILE, DOWNLOAD_FILE } from '../flomo/const'

export class MainUI extends Modal {

    plugin: Plugin;
    rawPath: string;
    selectedFile: File | null;

    constructor(app: App, plugin: Plugin) {
        super(app);
        this.plugin = plugin;
        this.rawPath = "";
        this.selectedFile = null;
    }

    async onSync(btn: ButtonComponent): Promise<void> {
        const isAuthFileExist = await fs.exists(AUTH_FILE)
        try {
            if (isAuthFileExist) {
                btn.setDisabled(true);
                btn.setButtonText("Exporting from Flomo ...");
                const exportResult = await (new FlomoExporter().export());
                
                btn.setDisabled(false);
                if (exportResult[0] == true) {
                    this.rawPath = DOWNLOAD_FILE;
                    this.selectedFile = null; // Clear selected file for auto sync
                    btn.setButtonText("Importing...");
                    await this.onSubmit();
                    btn.setButtonText("Auto Sync 🤗");
                } else {
                    throw new Error(exportResult[1]);
                }
            } else {
                const authUI: Modal = new AuthUI(this.app, this.plugin);
                authUI.open();
            }
        } catch (err) {
            console.log(err);
            await fs.remove(AUTH_FILE);
            btn.setButtonText("Auto Sync 🤗");
            new Notice(`Flomo Sync Error. Details:\n${err}`);
        }
    }

    async onSubmit(): Promise<void> {
        console.debug(`DEBUG: rawPath = "${this.rawPath}"`);
        console.debug(`DEBUG: selectedFile = `, this.selectedFile);
        
        // For manual file selection, handle the File object
        if (this.selectedFile && !this.rawPath) {
            try {
                // Create temporary file from the selected File object
                const tempDir = path.join(os.tmpdir(), 'flomo-import');
                await fs.mkdirp(tempDir);
                const tempFilePath = path.join(tempDir, this.selectedFile.name);
                
                // Convert File to Buffer and save temporarily
                const arrayBuffer = await this.selectedFile.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                await fs.writeFile(tempFilePath, buffer);
                
                this.rawPath = tempFilePath;
                console.debug(`DEBUG: Created temporary file at: ${this.rawPath}`);
            } catch (err) {
                console.error('Failed to create temporary file:', err);
                new Notice(`Failed to process selected file: ${err.message}`);
                return;
            }
        }
        
        if (!this.rawPath || this.rawPath.trim() === "") {
            new Notice("Please select a file first.");
            return;
        }

        const targetMemoLocation = this.plugin.settings.flomoTarget + "/" +
            this.plugin.settings.memoTarget;

        const res = await this.app.vault.adapter.exists(targetMemoLocation);
        if (!res) {
            console.debug(`DEBUG: creating memo root -> ${targetMemoLocation}`);
            await this.app.vault.adapter.mkdir(`${targetMemoLocation}`);
        }

        try {
            const config = this.plugin.settings;
            config["rawDir"] = this.rawPath;

            console.debug(`DEBUG: Starting import with config:`, config);

            const flomo = await (new FlomoImporter(this.app, config)).import();

            new Notice(`🎉 Import Completed.\nTotal: ${flomo.memos.length} memos`)
            
            // Clean up temporary file if we created one
            if (this.selectedFile && this.rawPath.includes(os.tmpdir())) {
                try {
                    await fs.remove(this.rawPath);
                    console.debug(`DEBUG: Cleaned up temporary file: ${this.rawPath}`);
                } catch (cleanupErr) {
                    console.warn('Failed to clean up temporary file:', cleanupErr);
                }
            }
            
            this.rawPath = "";
            this.selectedFile = null;

        } catch (err) {
            // Clean up temporary file on error
            if (this.selectedFile && this.rawPath.includes(os.tmpdir())) {
                try {
                    await fs.remove(this.rawPath);
                } catch (cleanupErr) {
                    console.warn('Failed to clean up temporary file on error:', cleanupErr);
                }
            }
            
            this.rawPath = "";
            this.selectedFile = null;
            console.log(err);
            new Notice(`Flomo Importer Error. Details:\n${err}`);
        }
    }

    onOpen() {

        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h3", { text: "Flomo Importer" });

        const fileLocContol: HTMLInputElement = contentEl.createEl("input", { type: "file", cls: "uploadbox" })
        fileLocContol.setAttr("accept", ".zip");
        
        // Improved file handling for Obsidian environment
        fileLocContol.onchange = (ev: Event) => {
            const target = ev.target as HTMLInputElement;
            if (target.files && target.files.length > 0) {
                const file = target.files[0];
                this.selectedFile = file;
                this.rawPath = ""; // Clear rawPath since we'll handle it in onSubmit
                
                console.debug(`DEBUG: File selected: ${file.name} (${file.size} bytes)`);
                new Notice(`File selected: ${file.name}`);
            } else {
                this.selectedFile = null;
                this.rawPath = "";
                console.debug(`DEBUG: No file selected`);
            }
        };

        contentEl.createEl("br");

        new Setting(contentEl)
            .setName('Flomo Home')
            .setDesc('set the flomo home location')
            .addText(text => text
                .setPlaceholder('flomo')
                .setValue(this.plugin.settings.flomoTarget)
                .onChange(async (value) => {
                    this.plugin.settings.flomoTarget = value;
                }));

        new Setting(contentEl)
            .setName('Memo Home')
            .setDesc('your memos are at: FlomoHome / MemoHome')
            .addText((text) => text
                .setPlaceholder('memos')
                .setValue(this.plugin.settings.memoTarget)
                .onChange(async (value) => {
                    this.plugin.settings.memoTarget = value;
                }));

        new Setting(contentEl)
            .setName('Moments')
            .setDesc('set moments style: flow(default) | skip')
            .addDropdown((drp) => {
                drp.addOption("copy_with_link", "Generate Moments")
                    .addOption("skip", "Skip Moments")
                    .setValue(this.plugin.settings.optionsMoments)
                    .onChange(async (value) => {
                        this.plugin.settings.optionsMoments = value;
                    })
            })

        new Setting(contentEl)
            .setName('Canvas')
            .setDesc('set canvas options: link | content(default) | skip')
            .addDropdown((drp) => {
                drp.addOption("copy_with_link", "Generate Canvas")
                    .addOption("copy_with_content", "Generate Canvas (with content)")
                    .addOption("skip", "Skip Canvas")
                    .setValue(this.plugin.settings.optionsCanvas)
                    .onChange(async (value) => {
                        this.plugin.settings.optionsCanvas = value;
                    })
            });

        const canvsOptionBlock: HTMLDivElement = contentEl.createEl("div", { cls: "canvasOptionBlock" });

        const canvsOptionLabelL: HTMLLabelElement = canvsOptionBlock.createEl("label");
        const canvsOptionLabelM: HTMLLabelElement = canvsOptionBlock.createEl("label");
        const canvsOptionLabelS: HTMLLabelElement = canvsOptionBlock.createEl("label");

        const canvsSizeL: HTMLInputElement = canvsOptionLabelL.createEl("input", { type: "radio", cls: "ckbox" });
        canvsOptionLabelL.createEl("small", { text: "large" });
        const canvsSizeM: HTMLInputElement = canvsOptionLabelM.createEl("input", { type: "radio", cls: "ckbox" });
        canvsOptionLabelM.createEl("small", { text: "medium" });
        const canvsSizeS: HTMLInputElement = canvsOptionLabelS.createEl("input", { type: "radio", cls: "ckbox" });
        canvsOptionLabelS.createEl("small", { text: "small" });

        canvsSizeL.name = "canvas_opt";
        canvsSizeM.name = "canvas_opt";
        canvsSizeS.name = "canvas_opt";

        switch (this.plugin.settings.canvasSize) {
            case "L":
                canvsSizeL.checked = true;
                break
            case "M":
                canvsSizeM.checked = true;
                break
            case "S":
                canvsSizeS.checked = true;
                break
        }

        canvsSizeL.onchange = (ev) => {
            this.plugin.settings.canvasSize = "L";
        };

        canvsSizeM.onchange = (ev) => {
            this.plugin.settings.canvasSize = "M";
        };

        canvsSizeS.onchange = (ev) => {
            this.plugin.settings.canvasSize = "S";
        };

        new Setting(contentEl).setName('Experimental Options').setDesc('set experimental options')

        const allowBiLink = createExpOpt(contentEl, "Convert bidirectonal link. example: [[abc]]")

        allowBiLink.checked = this.plugin.settings.expOptionAllowbilink;
        allowBiLink.onchange = (ev) => {
            this.plugin.settings.expOptionAllowbilink = ev.currentTarget.checked;
        };

        const mergeByDate = createExpOpt(contentEl, "Merge memos by date")

        mergeByDate.checked = this.plugin.settings.mergeByDate;
        mergeByDate.onchange = (ev) => {
            this.plugin.settings.mergeByDate = ev.currentTarget.checked;
        };

        new Setting(contentEl)
            .addButton((btn) => {
                btn.setButtonText("Cancel")
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.saveSettings();
                        this.close();
                    })
            })
            .addButton((btn) => {
                btn.setButtonText("Import")
                    .setCta()
                    .onClick(async () => {
                        if (this.selectedFile || this.rawPath != "") {
                            await this.plugin.saveSettings();
                            await this.onSubmit();
                            this.close();
                        }
                        else {
                            new Notice("No File Selected.")
                        }
                    })
            })
            .addButton((btn) => {
                btn.setButtonText("Auto Sync 🤗")
                    .setCta()
                    .onClick(async () => {
                        await this.plugin.saveSettings();
                        await this.onSync(btn);
                        //this.close();
                    })
            });   

    }

    onClose() {
        this.rawPath = "";
        this.selectedFile = null;
        const { contentEl } = this;
        contentEl.empty();
    }
}