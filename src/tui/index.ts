// Ported from Pi's TUI package.
//   https://github.com/earendil-works/pi @ 05bf9df65155e047e4ba8459eaee9735e29a2e53
//   packages/tui/src/index.ts
// Copyright (c) 2025 Mario Zechner. MIT License.
// Adapted for FlashCoder: .ts import specifiers changed to .js for NodeNext.

// Core TUI interfaces and classes

export { Marked, type Token, type Tokens } from "marked";
// Autocomplete support
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.js";
// Components
export { Box } from "./components/box.js";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.js";
export { HStack } from "./components/h-stack.js";
export { Image, type ImageOptions, type ImageTheme } from "./components/image.js";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "./components/markdown.js";
export { ScrollView, type ScrollViewOptions, type ScrollViewScrollbar } from "./components/scroll-view.js";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./components/select-list.js";
export { Spacer } from "./components/spacer.js";
export { Text } from "./components/text.js";
export { TruncatedText } from "./components/truncated-text.js";
export {
	type StackChild,
	type StackEntry,
	type StackEntryOptions,
	type StackOptions,
	VStack,
} from "./components/v-stack.js";
// Editor component interface (for custom editors)
// Fuzzy matching
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.js";
// Keybindings
export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.js";
// Keyboard input handling
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.js";
// Input buffering for batch splitting
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.js";
// Terminal interface and implementations
export { ProcessTerminal, type Terminal } from "./terminal.js";
// Terminal colors
export {
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./terminal-colors.js";
// Terminal image support
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.js";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	compositeTuiLine,
	type Focusable,
	isFocusable,
	isViewportTUI,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	type SizeValue,
	type TUI,
	type TuiInputListener,
	type TuiInputListenerResult,
	type TuiMode,
	type TuiStopOptions,
	type ViewportTUI,
} from "./tui.js";
export { TuiMainScreen, type TuiMainScreenRenderState } from "./tui-main-screen.js";
// Utilities
export {
	getOsc8LinkAtColumn,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "./utils.js";
