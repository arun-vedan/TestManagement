import { When } from '@cucumber/cucumber';

import clearInputField from '../support/action/clearInputField.js';
import clickElement from '../support/action/clickElement.js';
import closeLastOpenedWindow from '../support/action/closeLastOpenedWindow.js';
import deleteCookies from '../support/action/deleteCookies.js';
import dragElement from '../support/action/dragElement.js';
import focusLastOpenedWindow from '../support/action/focusLastOpenedWindow.js';
import handleModal from '../support/action/handleModal.js';
import moveTo from '../support/action/moveTo.js';
import pause from '../support/action/pause.js';
import pressButton from '../support/action/pressButton.js';
import scroll from '../support/action/scroll.js';
import selectOption from '../support/action/selectOption.js';
import selectOptionByIndex from '../support/action/selectOptionByIndex.js';
import setCookie from '../support/action/setCookie.js';
import setInputField from '../support/action/setInputField.js';
import setPromptText from '../support/action/setPromptText.js';
import switchIFrame from '../support/action/switchIFrame.js';

When(
    'I {word} on the {word} {string}',
    clickElement
);

When(
    'I addvalue/setvalue {string} to the inputfield {string}',
    setInputField
);

When(
    'I clear the inputfield {string}',
    clearInputField
);

When(
    'I drag element {string} to element {string}',
    dragElement
);

When(
    'I pause for {int}ms',
    pause
);

When(
    'I set a cookie {string} with the content {string}',
    setCookie
);

When(
    'I delete the cookie {string}',
    deleteCookies
);

When(
    'I press {string}',
    pressButton
);

When(
    'I {word} the {word}',
    handleModal
);

When(
    'I enter {string} into the prompt',
    setPromptText
);

When(
    'I scroll to element {string}',
    scroll
);

When(
    'I close the last opened {word}',
    closeLastOpenedWindow as never
);

When(
    'I focus the last opened {word}',
    focusLastOpenedWindow as never
);

When(
    'I select the {int}{word} option for element {string}',
    selectOptionByIndex as never
);

When(
    'I select the option with the {word} {string} for element {string}',
    selectOption
);

When(
    'I move to element {string}{string} with an offset of {int},{int}',
    moveTo
);

When(
    'I switch to the iframe {string}',
    switchIFrame
);
