import * as vscode from 'vscode';

let ctx: vscode.ExtensionContext;

interface UsageRecord {
    functionName: string;
    fileName: string;
    lineCount: number;
    paramCount: number;
}

export function activate(context: vscode.ExtensionContext) {
    ctx = context;
    context.subscriptions.push(
        vscode.commands.registerCommand('fastcomments.insertComment', insertComment),
        vscode.commands.registerCommand('fastcomments.showTelemetry', showTelemetry),
        vscode.commands.registerCommand('fastcomments.openKeybindings', openKeybindings),
        vscode.commands.registerCommand('fastcomments.toggleInsertPosition', toggleInsertPosition)
    );
}

export function deactivate() {}

// переключение режима вставки
async function toggleInsertPosition() {
    const config = vscode.workspace.getConfiguration('fastcomments');
    const current = config.get<string>('insertPosition', 'inside');
    
    let next = 'inside';
    if (current === 'inside') {
        next = 'before';
    }

    await config.update('insertPosition', next, vscode.ConfigurationTarget.Global);

    let message = '';
    if (next === 'inside') {
        message = 'Режим вставки: ВНУТРИ функции';
    } else {
        message = 'Режим вставки: ПЕРЕД функцией';
    }
        
    vscode.window.showInformationMessage(message);
}


// вставка шаблонного комментария в функцию
async function insertComment() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // поиск функции под курсором
    const func = await getFunctionAtCursor(editor);
    if (!func) {
        vscode.window.showWarningMessage('Не удалось найти функцию под курсором.');
        return;
    }

    // очистка имени от скобок
    const cleanFuncName = func.name.replace(/\s*\(.*\)\s*$/, '').trim();
    const funcText = editor.document.getText(func.range);
    
    // выделение сигнатуры до открывающей скобки
    let signature = funcText;
    const braceIdx = funcText.indexOf('{');
    if (braceIdx !== -1) {
        signature = funcText.substring(0, braceIdx);
    }
    
    // извлечение аргументов из скобок
    const firstParen = signature.indexOf('(');
    const lastParen = signature.lastIndexOf(')');
    let argumentsText = "";
    if (firstParen !== -1 && lastParen !== -1 && lastParen > firstParen) {
        argumentsText = signature.substring(firstParen + 1, lastParen).replace(/\s+/g, ' ').trim();
    }
    
    let argsSignature = argumentsText;
    let argsDocs = "";
    let argNames = "";
    let paramCount = 0;
    
    // парсинг каждого аргумента
    if (argumentsText.length > 0) {
        const args = argumentsText.split(',');
        const docLines: string[] = [];
        const names: string[] = [];
        
        for (let arg of args) {
            arg = arg.trim();
            if (!arg) continue;
            paramCount++;
            
            // удаление значений по умолчанию
            const eqIndex = arg.indexOf('=');
            if (eqIndex !== -1) arg = arg.substring(0, eqIndex).trim();
            
            // поиск чистого имени переменной
            const match = arg.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/);
            if (match) {
                const name = match[1];
                names.push(name);
                docLines.push(`${name} - (описание)`);
            } else {
                docLines.push(`${arg} - (описание)`);
            }
        }
        argsDocs = docLines.join('\n');
        argNames = names.join(', ');
    }

    // подстановка данных в шаблон из настроек
    const config = vscode.workspace.getConfiguration('fastcomments');
    const template = config.get<string>('commentTemplate', '/*\n${functionName}(${argumentsSignature}) - описание\n${argumentsDocs}\nпример использования: ${functionName}(${argumentsNames}) = ...\n*/');
    const insertPositionSetting = config.get<string>('insertPosition', 'inside');

    const comment = template
        .replace(/\${functionName}/g, cleanFuncName)
        .replace(/\${argumentsSignature}/g, argsSignature)
        .replace(/\${argumentsDocs}/g, argsDocs)
        .replace(/\${argumentsNames}/g, argNames);

    const lineCount = func.range.end.line - func.range.start.line + 1;
    let inserted = false;

    // вставка внутри блока функции
    if (insertPositionSetting === 'inside') {
        for (let i = func.range.start.line; i <= func.range.end.line; i++) {
            const lineText = editor.document.lineAt(i).text;
            const openBraceIndex = lineText.indexOf('{');
            
            if (openBraceIndex !== -1) {
                // ПРОВЕРКА НА ДУБЛИ ВНУТРИ ФУНКЦИИ
                // смотрим на следующую строку после {
                if (i + 1 <= func.range.end.line) {
                    const nextLine = editor.document.lineAt(i + 1).text.trim();
                    if (nextLine.startsWith('//') || nextLine.startsWith('/*') || nextLine.startsWith('*')) {
                        vscode.window.showWarningMessage('Внутри функции уже есть комментарий.');
                        return; // выходим, ничего не вставляем
                    }
                }

                const position = new vscode.Position(i, openBraceIndex + 1);
                
                let braceIndent = '';
                const matchBrace = lineText.match(/^\s*/);
                if (matchBrace) {
                    braceIndent = matchBrace[0];
                }
                
                const indent = braceIndent + '    ';
                const indentedComment = comment.split('\n').map(line => indent + line).join('\n');
                
                await editor.edit(edit => edit.insert(position, '\n' + indentedComment));
                inserted = true;
                break;
            }
        }
    }

    // вставка перед функцией
    if (!inserted) {
        const lineAbove = func.range.start.line - 1;
        if (lineAbove >= 0) {
            const prevLine = editor.document.lineAt(lineAbove).text.trim();
            // Проверка на дубли перед функцией
            if (prevLine.startsWith('//') || prevLine.startsWith('/*') || prevLine === '*/') {
                vscode.window.showWarningMessage('Над функцией уже есть комментарий.');
                return;
            }
        }

        const insertLine = func.range.start.line;
        const lineText = editor.document.lineAt(insertLine).text;
        
        let indent = '';
        const matchIndent = lineText.match(/^\s*/);
        if (matchIndent) {
            indent = matchIndent[0];
        }
        
        const indentedComment = comment.split('\n').map(line => indent + line).join('\n');
        const position = new vscode.Position(insertLine, 0);

        await editor.edit(edit => edit.insert(position, indentedComment + '\n'));
    }

    // сохранение метрик
    recordTelemetry(cleanFuncName, editor.document.fileName, lineCount, paramCount);
}

// поиск функции по позиции курсора
async function getFunctionAtCursor(editor: vscode.TextEditor) {
    const position = editor.selection.active;
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        editor.document.uri
    );
    if (!symbols || symbols.length === 0) return undefined;
    return findFunction(symbols, position);
}

// рекурсивный обход дерева символов
function findFunction(symbols: vscode.DocumentSymbol[], pos: vscode.Position): vscode.DocumentSymbol | undefined {
    for (const s of symbols) {
        const isFunc = s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method || s.kind === vscode.SymbolKind.Constructor;
        if (isFunc && s.range.contains(pos)) return s;
        if (s.children && s.children.length > 0) {
            const found = findFunction(s.children, pos);
            if (found) return found;
        }
    }
    return undefined;
}

// сохранение статистики
function recordTelemetry(functionName: string, fileName: string, lineCount: number, paramCount: number) {
    const config = vscode.workspace.getConfiguration('fastcomments');
    if (!config.get<boolean>('enableTelemetry', true)) return;
    
    const key = 'telemetry';
    const records = ctx.workspaceState.get<UsageRecord[]>(key, []);
    
    const existingIdx = records.findIndex(r => r.functionName === functionName && r.fileName === fileName);
    const newRecord = { functionName, fileName, lineCount, paramCount };
    
    // обновление существующей записи или создание новой
    if (existingIdx !== -1) {
        records[existingIdx] = newRecord;
    } else {
        records.push(newRecord);
    }
    
    ctx.workspaceState.update(key, records);
}

// отображение панели статистики
async function showTelemetry() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Откройте файл для просмотра статистики.');
        return;
    }

    const currentFile = editor.document.fileName;
    const records = ctx.workspaceState.get<UsageRecord[]>('telemetry', []);
    const fileRecords = records.filter(r => r.fileName === currentFile);

    // подсчет всех функций в файле
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        editor.document.uri
    );

    let totalFunctions = 0;
    if (symbols) {
        const countFuncs = (syms: vscode.DocumentSymbol[]) => {
            for (const s of syms) {
                if (s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method || s.kind === vscode.SymbolKind.Constructor) {
                    totalFunctions++;
                }
                if (s.children) countFuncs(s.children);
            }
        };
        countFuncs(symbols);
    }

    // создание окна webview
    const panel = vscode.window.createWebviewPanel(
        'fastTelemetry', 'Статистика FastComments', vscode.ViewColumn.One, {}
    );

    panel.webview.html = buildHtml(fileRecords, totalFunctions);
}

// генерация html кода
function buildHtml(records: UsageRecord[], totalFunctions: number): string {
    const documentedCount = records.length;
    
    let coveragePercent = 0;
    if (totalFunctions !== 0) {
        coveragePercent = Math.round((documentedCount / totalFunctions) * 100);
    }
    
    const sortedRecords = [...records].sort((a, b) => b.lineCount - a.lineCount);
    
    let maxLines = 1;
    for (const r of sortedRecords) {
        if (r.lineCount > maxLines) maxLines = r.lineCount;
    }

    // формирование строк с графиком
    let rows = '';
    for (const r of sortedRecords) {
        const percent = (r.lineCount / maxLines) * 100;
        rows += `
        <div class="row">
            <div class="name" title="${r.functionName}">${r.functionName}</div>
            <div class="bar">
                <div class="fill" style="width:${percent}%">${r.lineCount} строк</div>
            </div>
            <div class="params">${r.paramCount} пар.</div>
        </div>`;
    }

    let content = rows;
    if (rows.length === 0) {
        content = '<p>Нет данных. Поставьте курсор в функцию и нажмите хоткей (Ctrl+Alt+C).</p>';
    }

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 20px; color: #ccc; }
        h1, h2 { color: #fff; margin-bottom: 10px; }
        .dashboard { display: flex; gap: 20px; margin-bottom: 30px; }
        .card { background: #2d2d2d; padding: 20px; border-radius: 8px; flex: 1; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
        .card h3 { margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase; color: #888; }
        .card .value { font-size: 32px; font-weight: bold; color: #4a9eff; }
        
        .coverage-bar { width: 100%; height: 12px; background: #444; border-radius: 6px; margin-top: 10px; overflow: hidden; }
        .coverage-fill { height: 100%; background: #4caf50; border-radius: 6px; transition: width 0.3s; }

        .chart-container { margin-top: 20px; }
        .row { display: flex; align-items: center; margin: 8px 0; }
        .name { width: 250px; font-family: monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 10px; }
        .bar { flex: 1; background: #333; height: 24px; border-radius: 4px; }
        .fill { background: #4a9eff; height: 100%; border-radius: 4px; color: #fff; padding-left: 8px; box-sizing: border-box; font-size: 12px; line-height: 24px; min-width: 20px; }
        .params { width: 80px; text-align: right; font-size: 12px; color: #888; }
    </style>
</head>
<body>
    <h1>Анализ документации файла</h1>
    
    <div class="dashboard">
        <div class="card">
            <h3>Всего функций в файле</h3>
            <div class="value">${totalFunctions}</div>
        </div>
        <div class="card">
            <h3>Задокументировано плагином</h3>
            <div class="value">${documentedCount}</div>
        </div>
        <div class="card">
            <h3>Покрытие</h3>
            <div class="value">${coveragePercent}%</div>
            <div class="coverage-bar"><div class="coverage-fill" style="width:${coveragePercent}%"></div></div>
        </div>
    </div>

    <div class="chart-container">
        <h2>Размер задокументированных функций (строк кода)</h2>
        <p style="color:#888; font-size: 13px; margin-bottom: 20px;">Чем длиннее полоса, тем более сложную/объемную функцию вы задокументировали.</p>
        ${content}
    </div>
</body>
</html>`;
}

// открытие окна горячих клавиш
function openKeybindings() {
    vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'fastcomments');
}