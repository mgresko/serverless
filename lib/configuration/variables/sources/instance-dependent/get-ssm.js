'use strict';

const ensureString = require('type/string/ensure');
const ServerlessError = require('../../../../serverless-error');
const logDeprecation = require('../../../../utils/logDeprecation');

const legacyInstructions = new Set(['true', 'split']);

module.exports = (serverlessInstance) => {
  return {
    resolve: async ({ address, params, resolveConfigurationProperty }) => {
      // ssm(region = null):param-path
      if (!address) {
        throw new ServerlessError(
          'Missing address argument in variable "ssm" source',
          'MISSING_SLS_SOURCE_ADDRESS'
        );
      }
      address = ensureString(address, {
        Error: ServerlessError,
        errorMessage: 'Non-string address argument in variable "ssm" source: %v',
      });

      // TODO: Remove legacy instruction separator handling with next major
      let legacyShouldEnforceDecrypt = false;
      let legacyShouldEnforceSplit = false;
      const shouldEnforceModernResolver =
        (await resolveConfigurationProperty(['variablesResolutionMode'])) >= 20210326;
      if (!shouldEnforceModernResolver) {
        const legacyInstructionSeparator = address.lastIndexOf('~');
        if (legacyInstructionSeparator !== -1) {
          const instruction = address.slice(legacyInstructionSeparator + 1);
          if (legacyInstructions.has(instruction)) {
            address = address.slice(0, legacyInstructionSeparator);
            if (instruction === 'true') legacyShouldEnforceDecrypt = true;
            else legacyShouldEnforceSplit = true;
            logDeprecation(
              'NEW_VARIABLES_RESOLVER',
              'Syntax for referencing SSM parameters was upgraded with ' +
                'automatic type detection ' +
                'and there\'s no need to add "~true" or "~split" postfixes to variable references.\n' +
                'Drop those postfixes and set "variablesResolutionMode: 20210326" in your ' +
                'service config to adapt to a new behavior.\n' +
                'Starting with next major release, ' +
                'this will be communicated with a thrown error.\n',
              { serviceConfig: serverlessInstance.configurationInput }
            );
          }
        }
      }
      const result = await (async () => {
        try {
          return await serverlessInstance.getProvider('aws').request(
            'SSM',
            'getParameter',
            {
              Name: address,
              WithDecryption: true,
            },
            { useCache: true, region: params && params[0] }
          );
        } catch (error) {
          if (error.code === 'ParameterNotFound') return null;
          throw error;
        }
      })();

      if (!result) return { value: null };
      switch (result.Parameter.Type) {
        case 'String':
          if (!shouldEnforceModernResolver && legacyShouldEnforceSplit) {
            throw new ServerlessError(
              'Unexpected "ssm" variable "~split" instruction for non "StringList" value type. ' +
                "Please remove the postfix as it'll break the resolution in next major version." +
                'Falling back to old resolver',
              'NOT_SUPPORTED_LEGACY_SSM_INSTRUCTION'
            );
          }
          return { value: result.Parameter.Value };
        case 'StringList':
          if (!shouldEnforceModernResolver && !legacyShouldEnforceSplit) {
            throw new ServerlessError(
              'Unexpected "ssm" variable with no "~split" instruction ' +
                'for "StringList" value type. ' +
                'Set "variablesResolutionMode: 20210326" in service config ' +
                'to automatically split result string and adapt to new bahavior. ' +
                'Falling back to old resolver',
              'NOT_SUPPORTED_LEGACY_SSM_INSTRUCTION'
            );
          }
          return { value: result.Parameter.Value.split(',') };
        case 'SecureString':
          if (!shouldEnforceModernResolver && !legacyShouldEnforceDecrypt) {
            throw new ServerlessError(
              'Unexpected "ssm" variable with no "~true" instruction ' +
                'for "SecureString" value type. ' +
                'Set "variablesResolutionMode: 20210326" in service config ' +
                'to automatically decrypt result string and adapt to new bahavior. ' +
                'Falling back to old resolver',
              'NOT_SUPPORTED_LEGACY_SSM_INSTRUCTION'
            );
          }
          try {
            return { value: JSON.parse(result.Parameter.Value) };
          } catch {
            return { value: result.Parameter.Value };
          }
        default:
          throw new Error(`Unexpected parameter type: "${result.Parameter.Type}"`);
      }
    },
  };
};
