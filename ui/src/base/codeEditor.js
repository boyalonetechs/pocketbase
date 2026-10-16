window.app = window.app || {};
window.app.components = window.app.components || {};

/**
 * Basic code editor element with syntax highlight support.
 * For static code visualization use `app.components.codeBlock({ ... })`.
 *
 * @example
 * ```js
 * app.components.codeEditor({
 *     language: "html",
 *     value: () => data.myCode, // data is some store() instance
 *     singleLine: true,
 *     placeholder: "Type your html here...",
 *     oninput: (val) => {
 *         data.myCode = val
 *     },
 * })
 * ```
 *
 * @param  {Object} [propsArg]
 * @return {Element}
 */
window.app.components.codeEditor = function(propsArg = {}) {
    const props = store({
        rid: undefined,
        id: undefined,
        hidden: undefined,
        inert: undefined,
        name: undefined,
        className: "",
        value: "",
        language: "js", // see Prism.languages
        placeholder: "",
        disabled: false,
        required: false,
        singleLine: false,
        lineNumbers: false,
        // [
        //     "value",
        //     {value, label},
        // ]
        autocomplete: undefined, // Array<string|Object> | function(word): Array<string|Object>,
        // ---
        oninput: function(val) {},
        onfocus: function(val) {},
        onblur: function(val) {},
        onkeydown: function(e) {},
    });

    const extendWatchers = app.utils.extendStore(props, propsArg, "autocomplete");

    let dropdown;
    let visibilityObserver;
    let isFieldVisible = true;

    function openAutocompleteDropdown(items) {
        closeAutocompleteDropdown();

        dropdown = t.div(
            {
                className: "dropdown autocomplete code-editor-dropdown",
                onmount: (el) => {
                    el._updatePosition = () => {
                        if (!isFieldVisible) {
                            closeAutocompleteDropdown();
                        } else {
                            updateDropdownPosition(dropdown);
                        }
                    };
                    el._closeOnEsc = (e) => {
                        if (e.key == "Escape") {
                            e.preventDefault();
                            closeAutocompleteDropdown();
                        }
                    };
                    window.addEventListener("scroll", el._updatePosition, true);
                    window.addEventListener("resize", el._updatePosition);
                    window.addEventListener("keydown", el._closeOnEsc);
                    el._updatePosition();
                },
                onunmount: (el) => {
                    if (el) {
                        window.removeEventListener("scroll", el._updatePosition, true);
                        window.removeEventListener("resize", el._updatePosition);
                        window.removeEventListener("keydown", el._closeOnEsc);
                    }
                },
            },
            items,
        );

        document.body.appendChild(dropdown);

        // track editor field visibility to hide the dropdown when
        // not in the view port to avoid overflow issues
        if (editorContent) {
            visibilityObserver?.disconnect();
            visibilityObserver = new IntersectionObserver(
                ([entry]) => {
                    isFieldVisible = entry.isIntersecting;
                },
                {
                    root: null,
                    threshold: 0.1,
                },
            );
            visibilityObserver.observe(editorContent);
        }
    }

    function closeAutocompleteDropdown() {
        clearTimeout(autocompleteTimeoutId);

        if (dropdown) {
            dropdown.remove();
            dropdown = null;
        }

        if (visibilityObserver) {
            visibilityObserver.disconnect();
            visibilityObserver = null;
        }

        isFieldVisible = true;
    }

    // --- undo / redo history -----------------------------------------------
    // contenteditable + programmatic textContent updates break the native
    // undo stack, so we keep our own snapshots of {value, caret}.
    const history = {
        undos: [],
        redos: [],
        // coalesce rapid typing into a single undo step
        coalesceMs: 350,
        lastEditAt: 0,
        // the last committed (stable) state -> this is what we snapshot
        // BEFORE a new change lands
        committed: { value: props.value || "", caret: 0 },
    };

    function getCaret() {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !editorContent) {
            return 0;
        }
        const range = sel.getRangeAt(0);
        const pre = range.cloneRange();
        pre.selectNodeContents(editorContent);
        pre.setEnd(range.startContainer, range.startOffset);
        return pre.toString().length;
    }

    function applyCaret(pos) {
        try {
            const sel = window.getSelection();
            const range = document.createRange();
            const walker = document.createTreeWalker(editorContent, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            let remaining = pos;
            while (node) {
                const len = node.textContent.length;
                if (remaining <= len) {
                    range.setStart(node, remaining);
                    range.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }
                remaining -= len;
                node = walker.nextNode();
            }
            range.selectNodeContents(editorContent);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        } catch {
            // ignore caret restore failures
        }
    }

    function pushUndo(state) {
        const top = history.undos[history.undos.length - 1];
        if (top && top.value == state.value) {
            return;
        }
        history.undos.push(state);
        if (history.undos.length > 200) {
            history.undos.shift();
        }
    }

    // called right BEFORE the text changes: record the outgoing state so it
    // can be restored later by undo
    function recordEdit(force) {
        const now = Date.now();
        // coalesce edits that happen within the window (typing burst) into
        // a single undo step by only pushing the first outgoing state;
        // programmatic edits (force) always start a new undo step
        if (force || now - history.lastEditAt > history.coalesceMs) {
            pushUndo(history.committed);
        }
        history.lastEditAt = now;
        // a fresh user edit invalidates the redo chain
        history.redos = [];
    }

    function updateValue(newVal, options = {}) {
        if (!options.fromHistory) {
            recordEdit(options.force);
        }

        props.value = newVal;
        props.oninput?.(newVal);
        editorContent.dispatchEvent(new CustomEvent("change", { detail: newVal }));

        // after the change settles, remember it as the new baseline
        history.committed = { value: newVal, caret: getCaret() };
    }

    let isCtrlOrCmdKey = false;

    function undo() {
        if (!history.undos.length) {
            return;
        }
        // make the current state redoable
        history.redos.push({ value: editorContent.textContent, caret: getCaret() });

        const state = history.undos.pop();
        editorContent.textContent = state.value;
        updateValue(state.value, { fromHistory: true });
        applyCaret(state.caret);
        history.committed = { value: state.value, caret: state.caret };
        history.lastEditAt = 0;
        closeAutocompleteDropdown();
    }

    function redo() {
        if (!history.redos.length) {
            return;
        }
        history.undos.push({ value: editorContent.textContent, caret: getCaret() });

        const state = history.redos.pop();
        editorContent.textContent = state.value;
        updateValue(state.value, { fromHistory: true });
        applyCaret(state.caret);
        history.committed = { value: state.value, caret: state.caret };
        history.lastEditAt = 0;
        closeAutocompleteDropdown();
    }
    // -----------------------------------------------------------------------

    let valueWatcher;

    let autocompleteTimeoutId;

    // note1: use contenteditable so that we can call getBoundingClientRect on the selected text
    // note2: getSelection also doesn't seem to work in Firefox for textarea and inputs
    const editorContent = t.div({
        contentEditable: () => (props.disabled ? false : "plaintext-only"),
        tabIndex: 0,
        spellcheck: false,
        autocorrect: false,
        autocomplete: "off",
        autocapitalize: "off",
        role: "textbox",
        className: "code-editor-content",
        "html-data-placeholder": () => props.placeholder,
        onmount: (el) => {
            // auto change change textContent only if it props.value was
            // changed externally to preserve the focus and caret position
            valueWatcher?.unwatch();
            valueWatcher = watch(
                () => props.value,
                (value) => {
                    if (value != editorContent.textContent) {
                        editorContent.textContent = value;
                        closeAutocompleteDropdown();
                    }
                },
            );
        },
        onunmount: (el) => {
            valueWatcher?.unwatch();
            closeAutocompleteDropdown();
        },
        onfocus: () => {
            props.onfocus?.(props.value);
        },
        onblur: (e) => {
            // not blurred because of dropdown click
            if (dropdown && !dropdown.contains(e.relatedTarget)) {
                closeAutocompleteDropdown();
            }

            props.onblur?.(props.value);
        },
        oninput: (e) => {
            clearTimeout(autocompleteTimeoutId);

            updateValue(editorContent.textContent);

            if (!props.value?.length) {
                editorContent.textContent = ""; // ensure that no comments, br, etc. tags are left
                closeAutocompleteDropdown();
                return;
            }

            autocompleteTimeoutId = setTimeout(async () => {
                closeAutocompleteDropdown();

                if (!editorContent?.isConnected) {
                    return;
                }

                const pos = getCaretPos(editorContent);

                const match = getWord(props.value, pos);

                if (
                    !match.word.length
                    // don't show suggestions in case the cursor is at the
                    // beginning of an already typed word
                    || pos == match.start
                ) {
                    return;
                }

                let suggestions = [];
                if (typeof props.autocomplete == "function") {
                    suggestions = (await props.autocomplete(match.prefix || match.word)) || [];
                } else if (!app.utils.isEmpty(props.autocomplete)) {
                    const wordLowercased = (match.prefix || match.word).toLowerCase();
                    suggestions = props.autocomplete.filter((item) => {
                        if (typeof item == "object") {
                            item = item?.value;
                        }

                        item = item?.toLowerCase();

                        return item && item != wordLowercased && item.includes(wordLowercased);
                    });
                }

                if (
                    !suggestions?.length
                    // don't show if the only suggestion is exact match
                    || (
                        suggestions.length == 1
                        && (suggestions[0].value || suggestions[0]) == match.word
                    )
                ) {
                    return;
                }

                openAutocompleteDropdown(() => {
                    return suggestions.map((suggestion, i) => {
                        return t.button(
                            {
                                type: "button",
                                className: `dropdown-item ${i == 0 ? "active" : ""}`,
                                onclick: (e) => {
                                    e.preventDefault();

                                    editorContent.focus();

                                    const word = suggestion.value || suggestion;

                                    // note: replacing the text doesn't preserve the native "undo" history
                                    // (document.execCommand is being deprecated)
                                    editorContent.textContent = editorContent.textContent.substring(0, match.start)
                                        + word
                                        + editorContent.textContent.substring(match.end + 1);

                                    updateValue(editorContent.textContent, { force: true });

                                    try {
                                        window
                                            .getSelection()
                                            .setPosition(editorContent.childNodes[0], match.start + word.length);
                                    } catch (err) {
                                        console.warn("failed to set caret position", err);
                                    }

                                    closeAutocompleteDropdown();
                                },
                            },
                            (el) => {
                                if (typeof suggestion?.label == "function") {
                                    return suggestion.label(el);
                                }

                                return suggestion?.label || suggestion?.value || suggestion;
                            },
                        );
                    });
                });
            }, 50);
        },
        onkeydown: (e) => {
            isCtrlOrCmdKey = e.ctrlKey || e.metaKey;

            // allow the consumer to intercept (eg. ctrl+enter to run)
            props.onkeydown?.(e);
            if (e.defaultPrevented) {
                return;
            }

            // autocomplete nav
            // -------------------------------------------------------

            if ((e.key == "Enter" || e.key == "Tab") && dropdown?.isConnected) {
                e.preventDefault();
                dropdown.querySelector(".dropdown-item.active")?.click();
                return;
            }

            if (e.key == "ArrowUp" && dropdown?.isConnected) {
                e.preventDefault();

                const currentActive = dropdown.querySelector(".dropdown-item.active");
                if (currentActive?.previousElementSibling) {
                    currentActive.classList.remove("active");
                    currentActive.previousElementSibling.classList.add("active");
                    currentActive.previousElementSibling.scrollIntoView(false);
                }

                return;
            }

            if (e.key == "ArrowDown" && dropdown?.isConnected) {
                e.preventDefault();

                const currentActive = dropdown.querySelector(".dropdown-item.active");
                if (currentActive?.nextElementSibling) {
                    currentActive.classList.remove("active");
                    currentActive.nextElementSibling.classList.add("active");
                    currentActive.nextElementSibling.scrollIntoView(false);
                }

                return;
            }

            // editor shortcuts
            // -------------------------------------------------------

            if (isCtrlOrCmdKey && e.key.toLowerCase() == "l") {
                e.preventDefault();
                selectLine(editorContent);
                return;
            }

            if (isCtrlOrCmdKey && e.key.toLowerCase() == "d") {
                e.preventDefault();
                selectWord(editorContent);
                return;
            }
            if (isCtrlOrCmdKey && e.key.toLowerCase() == "z") {
                e.preventDefault();
                if (e.shiftKey) {
                    redo();
                } else {
                    undo();
                }
                return;
            }

            if (isCtrlOrCmdKey && e.key.toLowerCase() == "y") {
                e.preventDefault();
                redo();
                return;
            }

            if (isCtrlOrCmdKey && (e.key === "/" || e.key === "?")) {
                e.preventDefault();
                toggleLineComment(editorContent, updateValue);
                return;
            }

            // prevent "Tab trap"
            if (!props.singleLine && e.key == "Escape" && !dropdown?.isConnected) {
                editorContent?.blur();
                return;
            }

            if (!props.singleLine && e.key == "Tab") {
                e.preventDefault();
                const selection = window.getSelection();
                if (!selection) {
                    return;
                }

                // -1 tab level
                if (e.shiftKey) {
                    selection.modify("extend", "backward", "character");
                    if (selection.toString()[0] == "\t") {
                        selection.deleteFromDocument();
                        updateValue(editorContent.textContent, { force: true });
                    } else {
                        // check ahead and restore
                        selection.modify("extend", "forward", "character");
                        if (selection.toString()[0] == "\t") {
                            selection.deleteFromDocument();
                            updateValue(editorContent.textContent, { force: true });
                        }
                    }

                    return;
                }

                // +1 tab level
                const range = selection.getRangeAt(0);
                if (range) {
                    range.deleteContents();
                    range.insertNode(document.createTextNode("\t"));
                    range.collapse();
                    updateValue(editorContent.textContent, { force: true });
                }

                return;
            }

            // simulate single-line enter press
            if (props.singleLine && e.key == "Enter") {
                e.preventDefault();
                hiddenSubmit.click();
                return;
            }
        },
        onscroll: () => {
            closeAutocompleteDropdown();

            if (highlightOverlay) {
                highlightOverlay.scrollLeft = editorContent.scrollLeft;
                highlightOverlay.scrollTop = editorContent.scrollTop;
            }
        },
    });

    const highlightOverlay = t.div({
        className: () => `highlight-overlay language-${props.language}`,
        innerHTML: () => highlight(props.value, props.language),
        onscroll: () => {
            if (editorContent) {
                editorContent.scrollLeft = highlightOverlay.scrollLeft;
                editorContent.scrollTop = highlightOverlay.scrollTop;
            }
        },
    });

    const lineNumbersEl = props.lineNumbers
        ? t.pre({
            className: "code-editor-line-numbers",
            "aria-hidden": true,
            textContent: () => {
                const total = (props.value || "").split("\n").length || 1;
                let numbers = "";
                for (let i = 1; i <= total; i++) {
                    numbers += i + "\n";
                }
                return numbers;
            },
        })
        : null;

    const hiddenSubmit = t.button({
        type: "submit",
        className: "hidden",
    });

    return t.div(
        {
            rid: props.rid,
            id: () => props.id,
            inert: () => props.inert,
            hidden: () => props.hidden,
            "html-name": () => props.name,
            "html-required": () => props.required || undefined,
            // dprint-ignore
            className: () => `input code-editor ${props.className} ${props.disabled ? "disabled" : ""} ${props.singleLine ? "single-line" : ""} ${props.lineNumbers ? "has-line-numbers" : ""}`,
            onclick: () => {
                editorContent?.focus();
            },
            onunmount: () => {
                extendWatchers?.forEach((w) => w?.unwatch());
            },
        },
        lineNumbersEl,
        t.div({ className: "code-editor-container" }, editorContent, highlightOverlay, hiddenSubmit),
    );
};

const highlightThreshold = 850;

function highlight(content, language) {
    content = typeof content == "string" ? content : "";
    if (!content) {
        return "";
    }

    if (
        !Prism.languages[language]
        // fallback to plain to avoid performance issues with large text blocks
        || content.length > highlightThreshold
    ) {
        language = "plain";
    }

    return Prism.highlight(content, Prism.languages[language], language);
}

const wordCharRegex = new RegExp(/[\p{Alphabetic}\p{Number}_@:\."'{}]/, "u");

function getWord(value, caretPos) {
    let start = caretPos;
    for (let i = caretPos - 1; i >= 0; i--) {
        if (!wordCharRegex.test(value[i])) {
            break;
        }
        start = i;
    }

    let end = start;
    for (let i = caretPos - 1; i < value.length; i++) {
        if (!wordCharRegex.test(value[i])) {
            break;
        }
        end = i;
    }

    return {
        word: value.substring(start, end + 1),
        prefix: value.substring(start, caretPos),
        start: start,
        end: end,
    };
}

function selectLine() {
    const selection = window.getSelection();
    selection?.modify("move", "forward", "lineboundary");
    selection?.modify("extend", "backward", "lineboundary");
}

function selectWord() {
    const selection = window.getSelection();
    selection?.modify("move", "forward", "word");
    selection?.modify("extend", "backward", "word");
}

function toggleLineComment(editorContent, updateValue) {
    if (!editorContent) {
        return;
    }

    const text = editorContent.textContent ?? "";
    const selection = window.getSelection();

    // convert the current selection into absolute character offsets within the editor
    let selStart = text.length;
    let selEnd = text.length;
    if (selection && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        const startRange = range.cloneRange();
        startRange.selectNodeContents(editorContent);
        startRange.setEnd(range.startContainer, range.startOffset);
        selStart = startRange.toString().length;

        const endRange = range.cloneRange();
        endRange.selectNodeContents(editorContent);
        endRange.setEnd(range.endContainer, range.endOffset);
        selEnd = endRange.toString().length;
    }
    if (selStart > selEnd) {
        [selStart, selEnd] = [selEnd, selStart];
    }
    const caretPos = selEnd;

    const lines = text.split("\n");

    let startLine = text.slice(0, selStart).split("\n").length - 1;
    let endLine = text.slice(0, selEnd).split("\n").length - 1;
    if (startLine < 0) startLine = 0;
    if (endLine >= lines.length) endLine = lines.length - 1;

    const isMultiLine = endLine > startLine;

    let newText = text;
    let caretShift = 0;

    if (isMultiLine) {
        // block comment with /* ... */ wrapping the selection
        const before = text.slice(0, selStart);
        const inner = text.slice(selStart, selEnd);
        const after = text.slice(selEnd);

        const trimmedInner = inner.trim();
        if (trimmedInner.startsWith("/*") && trimmedInner.endsWith("*/")) {
            // already wrapped -> unwrap (strip the outer /* and */ markers)
            const openIdx = inner.indexOf("/*");
            const closeIdx = inner.lastIndexOf("*/");
            const body = inner.slice(openIdx + 2, closeIdx).replace(/^ /, "").replace(/ $/, "");
            newText = before + body + after;
            caretShift = -2;
        } else {
            newText = before + "/* " + inner + " */" + after;
            caretShift = 3;
        }
    } else {
        // single line -> // comment (same behavior as before)
        const line = lines[startLine];
        const trimmed = line.trim();
        if (trimmed.startsWith("//")) {
            const idx = line.indexOf("//");
            lines[startLine] = line.slice(0, idx) + line.slice(idx + 2);
            caretShift = -2;
        } else {
            const indent = line.length - line.trimStart().length;
            lines[startLine] = line.slice(0, indent) + "//" + line.slice(indent);
            caretShift = 2;
        }
        newText = lines.join("\n");
    }

    if (newText === text) {
        return;
    }

    editorContent.textContent = newText;
    updateValue?.(newText, { force: true });

    // restore caret within the same line
    let newCaret = caretPos + (caretPos >= selStart ? caretShift : 0);
    if (newCaret < 0) newCaret = 0;
    if (newCaret > newText.length) newCaret = newText.length;

    // place caret back into the contenteditable
    const range = document.createRange();
    const walker = document.createTreeWalker(editorContent, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let remaining = newCaret;
    while (node) {
        const len = node.textContent.length;
        if (remaining <= len) {
            range.setStart(node, remaining);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            break;
        }
        remaining -= len;
        node = walker.nextNode();
    }
}

function getCaretPos(editorContent) {
    const selection = window.getSelection();

    // new line adds a new text node which resets the selection counter
    // so we have to add them as offset
    let offset = 0;
    for (let node of editorContent.childNodes) {
        if (node == selection.focusNode) {
            break;
        } else {
            offset += node.length;
        }
    }

    return offset + selection.focusOffset;
}

function updateDropdownPosition(dropdown) {
    const targetRect = window.getSelection()?.getRangeAt(0)?.getBoundingClientRect();
    if (!targetRect || !dropdown) {
        return false;
    }

    if (targetRect.top < 0) {
        dropdown.classList.add("hidden");
        return;
    }

    dropdown.classList.remove("hidden");

    // reset
    dropdown.style.left = "0px";
    dropdown.style.top = "0px";

    const dropdownHeight = dropdown.offsetHeight;
    const dropdownWidth = dropdown.offsetWidth;

    let left = targetRect.left - 5;
    let top = targetRect.top + targetRect.height;

    // show on top if it cannot fit below the parent
    if (top + dropdownHeight > document.documentElement.clientHeight) {
        top = Math.max(targetRect.top - dropdownHeight, 0);
    }

    // align from the right edge if overflow
    if (left + dropdownWidth > document.documentElement.clientWidth) {
        left = Math.max(document.documentElement.clientWidth - dropdownWidth, 0);
    }

    dropdown.style.left = left + "px";
    dropdown.style.top = top + "px";
}
