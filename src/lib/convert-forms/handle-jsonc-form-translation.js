const fs = require('../sync-fs');
const Joi = require('joi');
const XLSX = require('xlsx');

const labelPattern = /^label(?:::[a-z]{2})?$/;
const constraintMessagePattern = /^constraint_message(?:::[a-z]{2})?$/;
const hintPattern = /^hint(?:::[a-z]{2})?$/;

const BASE_KEYS = {
  SURVEY: 'survey',
  CHOICES: 'choices',
  SETTINGS: 'settings'
};
const baseSchema = Joi.object({
  [BASE_KEYS.SETTINGS]: Joi.object().required(),
  [BASE_KEYS.CHOICES]: Joi.object().required(),
  [BASE_KEYS.SURVEY]: Joi.object().required(),
});

const SETTINGS_COLUMNS = {
  FORM_TITLE: 'form_title',
  FORM_ID: 'form_id',
  VERSION: 'version',
  STYLE: 'style',
  PATH: 'path',
  DEFAULT_LANGUAGE: 'default_language'
};
const settingsSchema = Joi.object({
  [SETTINGS_COLUMNS.FORM_TITLE]: Joi.string().required(),
  [SETTINGS_COLUMNS.FORM_ID]: Joi.string().required(),
  [SETTINGS_COLUMNS.VERSION]: Joi.string().required(),
  [SETTINGS_COLUMNS.STYLE]: Joi.string(),
  [SETTINGS_COLUMNS.PATH]: Joi.string(),
  [SETTINGS_COLUMNS.DEFAULT_LANGUAGE]: Joi.string()
});

const CHOICE_COLUMNS = {
  // Since these refs are basically JSON entry keys, they won't be used in Joi
  LIST_NAME: 'list_name',
  NAME: 'name',
  // The labels and custom filter fields are handled by joi
};
const choiceListEntrySchema = Joi.object({})
  .pattern(labelPattern, Joi.string())
  .unknown(true) // allow custom fields
  .custom((value, helpers) => {
    const labelKeys = Object.keys(value).filter(k => labelPattern.test(k));
    if (labelKeys.length === 0) {
      return helpers.error('any.invalid');
    }
    return value;
  });
const choiceListSchema = Joi.object({}).pattern(Joi.string(), choiceListEntrySchema);
const choicesSchema = Joi.object({ _filters: Joi.array().items(Joi.string()).default([]) })
  .pattern(Joi.string().invalid('_filters'), choiceListSchema) // For all other keys except '_filters'
  .custom((value, helpers) => {
    const filters = value._filters || [];
    for (const [listName, list] of Object.entries(value)) {
      if (listName === '_filters'){
        continue;
      }

      for (const [choiceName, entry] of Object.entries(list)) {
        for (const key of Object.keys(entry)) {
          const isLabel = labelPattern.test(key);
          if (!isLabel && !filters.includes(key)) {
            return helpers.error('any.custom', {
              message: `Custom field "${key}" in ${listName}.${choiceName} must be declared in _filters`
            });
          }
        }
      }
    }
    return value;
  });

const SURVEY_COLUMNS = {
  TYPE: 'type',
  NAME: 'name', // Omitted from Joi as the key is the name
  LABEL: 'label', // label or label::en, label::fr, etc.
  REQUIRED: 'required',
  RELEVANT: 'relevant',
  APPEARANCE: 'appearance',
  READ_ONLY: 'read_only',
  CONSTRAINT: 'constraint',
  CONSTRAINT_MSG: 'constraint_message', // constraint_message or constraint_message::en, constraint_message::fr, etc.
  CALCULATION: 'calculation',
  CHOICE_FILTER: 'choice_filter',
  HINT: 'hint', // hint or hint::en, hint::fr, etc.
  DEFAULT: 'default',
  REPEAT_COUNT: 'repeat_count'
};
const SURVEY_JSON_SPECIFIC_REFS = {
  GROUP: 'group',
  REPEAT: 'repeat'
};

const surveyEntry = Joi.object({
  [SURVEY_COLUMNS.TYPE]: Joi.string().required(),
  [SURVEY_COLUMNS.REQUIRED]: Joi.boolean(),
  [SURVEY_COLUMNS.RELEVANT]: Joi.string(),
  [SURVEY_COLUMNS.APPEARANCE]: Joi.string(),
  [SURVEY_COLUMNS.READ_ONLY]: Joi.boolean(),
  [SURVEY_COLUMNS.CONSTRAINT]: Joi.string(),
  [SURVEY_COLUMNS.CALCULATION]: Joi.string(),
  [SURVEY_COLUMNS.CHOICE_FILTER]: Joi.string(),
  [SURVEY_COLUMNS.DEFAULT]: Joi.string(),
  [SURVEY_COLUMNS.REPEAT_COUNT]: Joi.string(),

  children: Joi.when(SURVEY_COLUMNS.TYPE, {
    is: Joi.valid(SURVEY_JSON_SPECIFIC_REFS.GROUP, SURVEY_JSON_SPECIFIC_REFS.REPEAT),
    then: Joi.object().pattern(Joi.string(), Joi.link('#node')).optional(),
    otherwise: Joi.forbidden()
  })
})
  .pattern(labelPattern, Joi.string())
  .pattern(constraintMessagePattern, Joi.string())
  .pattern(hintPattern, Joi.string())
  .id('node');
const surveySchema = Joi.object().pattern(Joi.string(), surveyEntry);

const processSettings = (data) => [{
  [SETTINGS_COLUMNS.FORM_TITLE]: data[SETTINGS_COLUMNS.FORM_TITLE],
  [SETTINGS_COLUMNS.FORM_ID]: data[SETTINGS_COLUMNS.FORM_ID],
  [SETTINGS_COLUMNS.VERSION]: data[SETTINGS_COLUMNS.VERSION],
  [SETTINGS_COLUMNS.STYLE]: data[SETTINGS_COLUMNS.STYLE],
  [SETTINGS_COLUMNS.PATH]: data[SETTINGS_COLUMNS.PATH],
  [SETTINGS_COLUMNS.DEFAULT_LANGUAGE]: data[SETTINGS_COLUMNS.DEFAULT_LANGUAGE]
}];

const processChoices = data => Object.entries(data).flatMap(([listName, obj]) => 
  Object.entries(obj).map(([name, props]) => ({
    [CHOICE_COLUMNS.LIST_NAME]: listName,
    [CHOICE_COLUMNS.NAME]: name,
    ...props
  }))
);

const processSurvey = (data) => {
  const survey = [];
  
  const walk = (key, obj) => {
    const {children, type, ...props} = obj;
    const isGroup = (type === SURVEY_JSON_SPECIFIC_REFS.GROUP || type === SURVEY_JSON_SPECIFIC_REFS.REPEAT);

    if(isGroup){
      survey.push({ 
        [SURVEY_COLUMNS.TYPE]: `begin ${type}`, 
        [SURVEY_COLUMNS.NAME]: key, 
        ...props 
      });

      if(children){
        for(const [childKey, childObj] of Object.entries(children)){
          walk(childKey, childObj);
        }
      }

      survey.push({ 
        [SURVEY_COLUMNS.TYPE]: `end ${type}`, 
        [SURVEY_COLUMNS.NAME]: key 
      });
    }
    else {
      survey.push({ 
        [SURVEY_COLUMNS.TYPE]: type, 
        [SURVEY_COLUMNS.NAME]: key, ...props 
      });
    }
  };

  for(const [key, obj] of Object.entries(data)){
    walk(key, obj);
  }

  return survey;
};

const validateOrThrow = (schema, data, key) => {
  const { error, value } = schema.validate(data);
  if (error) {
    throw new Error(`JSON form validation error on '${key}' with error: ${error.message}`);
  }
  return value;
};

module.exports = {
  handleJSONCFormConversion: (formsDir, form, fromExtension, toExtension) => {
    const jsoncFilePath = `${formsDir}/${form + fromExtension}`;
    const xlsxFilePath = `${formsDir}/${form + toExtension}`;

    const content = validateOrThrow(baseSchema, fs.readJsonc(jsoncFilePath), 'base');
    const settings = validateOrThrow(settingsSchema, content.settings, BASE_KEYS.SETTINGS);
    const choices = validateOrThrow(choicesSchema, content.choices, BASE_KEYS.CHOICES);
    // eslint-disable-next-line no-unused-vars
    const { _filters, ...choicesClean} = choices; // We no longer need _filters after validation
    const survey = validateOrThrow(surveySchema, content.survey, BASE_KEYS.SURVEY);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(processSettings(settings)), BASE_KEYS.SETTINGS);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(processChoices(choicesClean)), BASE_KEYS.CHOICES);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(processSurvey(survey)), BASE_KEYS.SURVEY);

    XLSX.writeFile(workbook, xlsxFilePath, { compression: true });
    return xlsxFilePath;
  }
};
