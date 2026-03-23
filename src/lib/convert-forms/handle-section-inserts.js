const { getNodes, getNode, removeNode, getPrimaryInstanceNode, XPATH_MODEL, XPATH_BODY } = require('../forms-utils');
const { DOMParser } = require('@xmldom/xmldom');

const MAX_UI_DEPTH = 50;

// XML/PyXForm lookup keys
const XML_DATA = '/data/'; // Base of Model "bind" and UI "nodesets" paths values 
const XML_ATT_REF = 'ref';
const XML_ATT_NODESET = 'nodeset';
const XML_ATT_CALCULATE = 'calculate';

// CHT lookup keys
const CHT_MODULE_INCLUDE_BASE_KEY = '__cht_include-'; 

// Map keys
const MAP_REF = 'ref';
const MAP_BASE_PATH = 'basePath';
const MAP_INCLUDE_MODULE_PREFIX = 'sectionRef';
const MAP_UI_INCLUDE_MODULE_GROUP_NODE = 'group';
const MAP_INSTANCE_INCLUDE_MODULE_GROUP_NODE = 'instancesGroup';

// Let's break the functionality down into a couple of steps:
// 1. Build up include ref map
// 2. Update instance group (choice sheet excl for now)
// 3. Update bind group
// 4. Update UI group

// ------------------------------------------------- UTIL METHODS -------------------------------------------------

const safeSubstringAfter = (str, marker) => {
  const idx = str.indexOf(marker);
  return idx === -1 ? null : str.substring(idx + marker.length);
};

const rebaseBindPath = (path, newBase) => {
  const idx = path.indexOf(XML_DATA);
  if (idx === -1) {
    throw new Error(`Unable to grab index of: ${XML_DATA}`);
  }

  const remainder = path.substring(idx + XML_DATA.length);
  return `${newBase}/${remainder}`;
};

// ----------------------------------------------------------------------------------------------------------------

const getModule = (key) => {
  console.log('Lookup module: ', key);

  // TODO: replace with module lookup
  return `<?xml version="1.0"?>
    <h:html xmlns="http://www.w3.org/2002/xforms"
            xmlns:h="http://www.w3.org/1999/xhtml"
            xmlns:jr="http://openrosa.org/javarosa">

    <h:head>
        <h:title>Location Capture Form</h:title>

        <model>
        <instance>
            <data id="location-form">

            <!-- Include params at ROOT level -->
            <__cht_include_input_param-my_input_value/>
            <__cht_include_output_param-full_address/>
            <__cht_include_output_param-summary/>

            <!-- Actual form data -->
            <capture>
                <address/>
                <details>
                  <street/>
                  <postal_code/>
                </details>
            </capture>

            </data>
        </instance>

        <!-- Input param (external injection) -->
        <bind nodeset="/data/__cht_include_input_param-my_input_value"
                type="string"
                calculate="string(../some_context_value)"/>

        <!-- Address input -->
        <bind nodeset="/data/capture/address"
                type="string"
                required="true()"/>

        <!-- Nested fields -->
        <bind nodeset="/data/capture/details/street"
                type="string"
                required="true()"/>
        
        <bind nodeset="/data/capture/details/postal_code"
                type="string"
                required="true()"/>

        <!-- Output param (derived from form inputs) -->
        <bind nodeset="/data/__cht_include_output_param-full_address"
                type="string"
                calculate="concat(../capture/address, ../capture/details/street, ../capture/details/postal_code)"/>

        <bind nodeset="/data/__cht_include_output_param-summary"
                type="string"
                calculate="../capture/address"/>
        </model>
    </h:head>

    <h:body>
        <!-- Show injected input param -->
        <input ref="/data/__cht_include_input_param-my_input_value" readonly="true()">
            <label>Injected value:</label>
        </input>

        <group ref="/data/capture">
          <!-- Actual user input -->
          <input ref="/data/capture/address">
              <label>Enter address/location</label>
          </input>

          <group ref="/data/capture/details">
            <input ref="/data/capture/details/street">
              <label>Enter street</label>
            </input>

            <input ref="/data/capture/details/postal_code">
              <label>Enter postal code</label>
            </input>
          </group>
        </group>
    </h:body>

    </h:html>`;
};

// TODO: Avoid mutating the xml directly. Clone then mutate. In case downstream re-use or if something goes wrong.

const buildModuleIncludeRefMap = (xmlDoc) => {
  const INPUT_KEY = '__cht_include_input_param-';
  const OUTPUT_KEY = '__cht_include_output_param-';

  const map = new Map();

  const includeGroups = getNodes(
    xmlDoc,
    `${XPATH_BODY}//*[contains(@${XML_ATT_REF}, "${CHT_MODULE_INCLUDE_BASE_KEY}")]`
  );
  includeGroups.forEach(node => {
    const ref = node.getAttribute(XML_ATT_REF);
    const basePath = ref.substring(0, ref.indexOf(CHT_MODULE_INCLUDE_BASE_KEY));
    const name = safeSubstringAfter(ref, CHT_MODULE_INCLUDE_BASE_KEY);

    if(!ref || !basePath || !name){
      throw Error('Unable to determine required prop values');
    }

    map.set(name, {
      [MAP_REF]: ref,
      [MAP_BASE_PATH]: basePath,
      [MAP_UI_INCLUDE_MODULE_GROUP_NODE]: node
    });
  });

  map.forEach((value, key) => {
    console.log('Now building module map: ', key);
    console.log('Ref: ', value.ref);

    const includeBinds = getNodes(
      xmlDoc,
      `${XPATH_MODEL}/bind[contains(@${XML_ATT_NODESET}, "${value.ref}")]`
    );
    includeBinds.forEach(node => {
      const ref = node.getAttribute(XML_ATT_NODESET);
      console.log('Bind ref: ', ref);
      const calc = node.getAttribute(XML_ATT_CALCULATE);
      if(calc === null || calc === undefined){
        throw Error('No calculation set.');
      }

      if(value.ref === ref){
        console.log('Matches the group name exactly, grabbing section ref');
        value[MAP_INCLUDE_MODULE_PREFIX] = calc;
      }
      else{
        const trimmedRef = safeSubstringAfter(ref, `${value.ref}/`); // Vars have a delimiter
        console.log('Vars: ', trimmedRef);
        if(trimmedRef !== null && trimmedRef !== undefined){

          if(trimmedRef.startsWith(INPUT_KEY)){
            console.log('contains input key');
            (value.inputs = (value.inputs ? value.inputs : new Map())).set(trimmedRef, calc);
          }

          if(trimmedRef.startsWith(OUTPUT_KEY)){
            console.log('contains output key');
            (value.outputs = (value.outputs ? value.outputs : new Map())).set(trimmedRef, calc);
          }
        }
      }
    });
  });

  return map;
};

const updateInstanceGroup = (xmlDoc, moduleName, moduleRefInfo, section) => {
  // 1. First clear the existing main form data
  const includeInstanceNode = getNode(
    getPrimaryInstanceNode(xmlDoc),
    `.//*[contains(name(), "${CHT_MODULE_INCLUDE_BASE_KEY + moduleName}")]`
  );
  while (includeInstanceNode.firstChild) {
    includeInstanceNode.removeChild(includeInstanceNode.firstChild);
  }
  moduleRefInfo[MAP_INSTANCE_INCLUDE_MODULE_GROUP_NODE] = includeInstanceNode;
  
  // 2.  Insert section instance data into main form
  const instanceDataNode = getNode(
    getPrimaryInstanceNode(section),
    `./data`
  );
  if (!instanceDataNode) {
    throw new Error(`Module "${moduleName}" missing <data> node`);
  }
  const excludeTags = ['input', 'meta'];
  const children = Array.from(instanceDataNode.childNodes).filter(child => {
    return child.nodeType === 1 && 
      !excludeTags.includes(child.tagName?.toLowerCase());
  });
  children.forEach(child => {
    moduleRefInfo.instancesGroup.appendChild(child.cloneNode(true));
  });
};

const updateModuleGroupBinds = (xmlDoc, value, section) => {
  const PARAM_BASE = '__cht_include_';
  console.log('Value ref: ', value.ref);

  // 3. Remove original "bind" related info - we already grabbed the into
  const bindNodes = getNodes(
    xmlDoc,
    `${XPATH_MODEL}/bind[contains(@${XML_ATT_NODESET}, "${value.ref}")]`
  );
  for(const node of bindNodes){
    removeNode(node);
  }

  // 4. Update section input bind nodes and transfer back to main
  const mainFormModel = getNode(xmlDoc, XPATH_MODEL);
  
  const sectionBindNodes = getNodes(
    section,
    `${XPATH_MODEL}/bind[contains(@${XML_ATT_NODESET}, "${PARAM_BASE}")]`
  );

  for (const bind of sectionBindNodes) {
    const nodeset = bind.getAttribute(XML_ATT_NODESET);

    const start = nodeset.indexOf(PARAM_BASE);
    const name = nodeset.substring(start);

    const inputCalVal = value.inputs && value.inputs.get(name);

    // 1. Override inputs ONLY
    if (inputCalVal) {
      bind.setAttribute(XML_ATT_CALCULATE, inputCalVal);
    }

    // 2. NEVER touch output calculate
    // (leave module logic intact)

    // 3. ALWAYS rebase nodeset
    const ref = bind.getAttribute(XML_ATT_NODESET);
    bind.setAttribute(XML_ATT_NODESET, rebaseBindPath(ref, value.ref));

    mainFormModel.appendChild(bind.cloneNode(true));
  }
};

const updateUIIncludeGroup = (key, value, section) => {
  // 5. Update the UI. Replace the contents of the group.
  const groupChildren = value.group.childNodes;
  if(groupChildren && groupChildren.length > 0){
    // While the main group should only contain calculate fields, which collapses it, it's possible
    // that some fields might be placed in error. In that case, clear the fields.
    while (value.group.firstChild) {
      value.group.removeChild(value.group.firstChild);
    }
  }

  // 6. Set the content
  const uiContent = getNode(section, XPATH_BODY);
  if (!uiContent) {
    console.log(`No ui node found for key: ${key}`);
    return;
  }

  const recursivelyUpdateRefPath = (node, baseRef, depth = 0) => {
    if (depth > MAX_UI_DEPTH) {
      throw new Error('Recursion depth exceeded - possible cycle');
    }

    if (node.nodeType !== 1){
      return;
    }

    const ref = node.getAttribute(XML_ATT_REF);

    if (ref && ref.includes(XML_DATA)) {
      node.setAttribute(XML_ATT_REF, rebaseBindPath(ref, baseRef));
    }

    const children = Array.from(node.childNodes);
    for(const child of children){
      recursivelyUpdateRefPath(child, baseRef, depth+1);
    }
  };

  const children = Array.from(uiContent.childNodes);
  for(const child of children){
    if(child.nodeType !== 1){
      continue;
    }
    // Will only be on the root level
    const ref = child.getAttribute(XML_ATT_REF);
    if(ref && (ref.includes('/data/inputs') || ref.includes('/data/chw'))){
      continue;
    }

    const cloned = child.cloneNode(true);
    recursivelyUpdateRefPath(cloned, value.ref);
    value.group.appendChild(cloned);
  }
};

/**
 * "xmlDoc": The implementing document. I.e the document containing the include
 * "map": Collection of to-be-processed form module references
*/
const substituteRefsWithModules = (xmlDoc, map) => {
  if(map.size > 0){
    const domParser = new DOMParser();

    map.forEach((value, key) => {
      const section = domParser.parseFromString(getModule(key));
      updateInstanceGroup(xmlDoc, key, value, section);
      updateModuleGroupBinds(xmlDoc, value, section);
      updateUIIncludeGroup(key, value, section);
    });

    console.log('Done!');
  }
};

module.exports = {
  // The idea is that form sections, or modular parts, should be captured in the same format as existing forms
  // Apart from user impl familiarity, the forms can also benefit from the same validation that OG forms are afforded
  // If necessary, these modules could be tested standalone ?
  // Variables in the section form marked as "__cht_include_input_param-" WILL be overwritten.
  // Simple value insert aside, this opens up the possibility to overwrite functionality like constraints or skip logic.
  // "__cht_include_input_param-" can be referenced outside of the include block to draw on module values.
  // IMPORTANT: the input & output vars should be declared on the root of the module form. This ensures that relative
  // path references, in the main form, will continue to work correctly.
  // Additionally, forcing root level include var declaration ensures no duplicate named vars in nested groups.
  // IMPORTANT: only use relative paths or var references using ${}. Although, the latter may result in conflicts.
  // DO NOT DEPEND ON ITEMS OUTSIDE OF THE FORM DIRECTLY
  // For example: /data/inputs/user/contact_id. Certain Module groups are stripped. May still work, but not supported.
  // Sections, or modules, can be shared in app forms and contact forms.
  // The naming convention, apart from indicating cht specific functionality, should make it easier to 
  // disregard certain values from app reports. In our case, it also helps with downstream column exclusions.

  /**
   * Layer:     | Value                     | Description                                                           | 
   * -----------|---------------------------|-----------------------------------------------------------------------|
   * UI         | /data/capture/new_field   | Groupings and appearance related info                                 |
   * Instance   | <capture><new_field>      | Data structure. Inputs, meta, pages, and the section that gets saved  |
   * Bind       | /data/capture/new_field   | Logic. Contains calculations                                          |
   */

  /**
   * Example implementation:
   * Main form:
   * Type       | Name                                        | Calculation                                         |
   * -----------|---------------------------------------------|-----------------------------------------------------|
   * begin group| __cht_include-location                      | <prefix used for ?, e.g. location>                  |
   * calculate  | __cht_include_input_param-my_input_value    | <legitimate input value, e.g. 5 + 5>                |
   * calculate  | __cht_include_output_param-my_output_value  | <some placeholder output value, e.g. 10 + 10>       |
   * end group  | __cht_include-location                      |                                                     |
   * note       | section_output                              | ${__cht_include_output_param-my_output_value}       |
   * 
   * Donor form:
   * <place input & output calculate fields on root level>
   * calculate  | __cht_include_input_param-my_input_value    | <some placeholder input value, e.g. 1>                 |
   * begin group| some_content                                |                                                        |
   * note       | unit_number                                 | string(../../__cht_include_input_param-my_input_value) |
   * string     | address                                     |                                                        |
   * end group  | some_content                                |                                                        |
   * calculate  | __cht_include_output_param-my_output_value  | string(../some_content/address)                        |
  */

  // TODO: choice sheet vals can come from module, implementing form, or combination
  // "combination" or "current" might require the use of the "prefix"

  handleModuleInserts: (xmlDoc) => substituteRefsWithModules(xmlDoc, buildModuleIncludeRefMap(xmlDoc))
};
