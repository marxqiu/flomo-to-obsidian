import * as path from 'path';
import * as os from 'os';
import *  as fs from 'fs-extra';

import { App } from 'obsidian';
import decompress from 'decompress';
import * as parse5 from "parse5"

import { FlomoCore } from './core';
import { generateMoments } from '../obIntegration/moments';
import { generateCanvas } from '../obIntegration/canvas';

import { FLOMO_CACHE_LOC } from './const'

export class FlomoImporter {
    private config: Record<string, any>;
    private app: App;

    constructor(app: App, config: Record<string, string>) {
        this.config = config;
        this.app = app;
        this.config["baseDir"] = app.vault.adapter.basePath;
    }

    private async sanitize(path: string): Promise<string> {
        const flomoData = await fs.readFile(path, "utf8");
        const document = parse5.parse(flomoData);
        return parse5.serialize(document);
    }

    private async importMemos(flomo: FlomoCore): Promise<FlomoCore> {
        const allowBilink: boolean = this.config["expOptionAllowbilink"];
        const margeByDate: boolean = this.config["mergeByDate"];

        for (const [idx, memo] of flomo.memos.entries()) {

            const memoSubDir = `${this.config["flomoTarget"]}/${this.config["memoTarget"]}/${memo["date"]}`;
            const memoFilePath = margeByDate ? `${memoSubDir}/memo@${memo["date"]}.md` : `${memoSubDir}/memo@${memo["title"]}_${flomo.memos.length - idx}.md`;

            await fs.mkdirp(`${this.config["baseDir"]}/${memoSubDir}`);
            const content = (() => {
                // @Mar-31, 2024 Fix: #20 - Support <mark>.*?<mark/>
                // Break it into 2 stages, too avoid "==" translating to "\=="
                //  1. Replace <mark> & </mark> with FLOMOIMPORTERHIGHLIGHTMARKPLACEHOLDER (in lib/flomo/core.ts)
                //  2. Replace FLOMOIMPORTERHIGHLIGHTMARKPLACEHOLDER with ==
                const res = memo["content"].replaceAll("FLOMOIMPORTERHIGHLIGHTMARKPLACEHOLDER", "==");

                if (allowBilink == true) {
                    return res.replace(`\\[\\[`, "[[").replace(`\\]\\]`, "]]");
                }

                return res;

            })();

            if (!(memoFilePath in flomo.files)) {
                flomo.files[memoFilePath] = []
            }

            flomo.files[memoFilePath].push(content);
        }

        for (const filePath in flomo.files) {
            await this.app.vault.adapter.write(
                filePath,
                flomo.files[filePath].join("\n\n---\n\n")
            );
        }

        return flomo;
    }

    async import(): Promise<FlomoCore> {
        // Validate input file exists
        if (!this.config["rawDir"]) {
            throw new Error("No input file specified");
        }

        // Check if the file exists
        const fileExists = await fs.pathExists(this.config["rawDir"]);
        if (!fileExists) {
            throw new Error(`Input file does not exist: ${this.config["rawDir"]}`);
        }

        // Check if it's a valid zip file by checking extension
        if (!this.config["rawDir"].toLowerCase().endsWith('.zip')) {
            throw new Error("Input file must be a ZIP file");
        }

        // 1. Create workspace
        const tmpDir = path.join(FLOMO_CACHE_LOC, "data");
        await fs.mkdirp(tmpDir);

        // 2. Unzip flomo_backup.zip to workspace
        let files;
        try {
            console.debug(`DEBUG: Decompressing ${this.config["rawDir"]} to ${tmpDir}`);
            files = await decompress(this.config["rawDir"], tmpDir);
            
            if (!files || files.length === 0) {
                throw new Error("No files found in the archive");
            }
            
            console.debug(`DEBUG: Extracted ${files.length} files`);
        } catch (error) {
            console.error(`DEBUG: Decompression failed:`, error);
            throw new Error(`Failed to extract ZIP file: ${error.message}`);
        }

        try {
            // 3. copy attachments to ObVault
            const obVaultConfig = await fs.readJson(`${this.config["baseDir"]}/${this.app.vault.configDir}/app.json`)
            const attachementDir = obVaultConfig["attachmentFolderPath"] + "/flomo/";

            for (const f of files) {
                if (f.type == "directory" && f.path.endsWith("/file/")) {
                    console.debug(`DEBUG: copying from ${tmpDir}/${f.path} to ${this.config["baseDir"]}/${attachementDir}`)
                    await fs.copy(`${tmpDir}/${f.path}`, `${this.config["baseDir"]}/${attachementDir}`);
                    break
                }
            }

            // 4. Import Memos
            // Find the HTML file - look for any .html file in the extracted files
            const htmlFiles = files.filter(f => f.path.endsWith('.html') && f.type === 'file');
            
            if (htmlFiles.length === 0) {
                throw new Error("No HTML file found in the archive");
            }

            // Use the first HTML file found, or find the main one
            let defaultPage = htmlFiles[0].path;
            
            // If there are multiple HTML files, prefer index.html or a file that looks like a user ID
            const preferredFile = htmlFiles.find(f => 
                f.path === 'index.html' || 
                /^\d+\.html$/.test(path.basename(f.path))
            );
            
            if (preferredFile) {
                defaultPage = preferredFile.path;
            }

            console.debug(`DEBUG: Using HTML file: ${defaultPage}`);
            
            const htmlFilePath = path.join(tmpDir, defaultPage);
            
            // Verify the HTML file exists
            if (!(await fs.pathExists(htmlFilePath))) {
                throw new Error(`HTML file not found: ${htmlFilePath}`);
            }

            const dataExport = await this.sanitize(htmlFilePath);
            const flomo = new FlomoCore(dataExport);

            const memos = await this.importMemos(flomo);

            // 5. Ob Intergations
            // If Generate Moments
            if (this.config["optionsMoments"] != "skip") {
                await generateMoments(this.app, memos, this.config);
            }

            // If Generate Canvas
            if (this.config["optionsCanvas"] != "skip") {
                await generateCanvas(this.app, memos, this.config);
            }

            // 6. Cleanup Workspace
            await fs.remove(tmpDir);

            return flomo;
            
        } catch (error) {
            // Cleanup on error
            await fs.remove(tmpDir).catch(() => {});
            throw error;
        }
    }
}