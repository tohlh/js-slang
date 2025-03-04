import { parse as babelParse } from '@babel/parser'
import { Options as AcornOptions } from 'acorn'
import { Program } from 'estree'

import { Context } from '../../..'
import { DEFAULT_ECMA_VERSION } from '../../../constants'
import * as TypedES from '../../../typeChecker/tsESTree'
import { checkForTypeErrors } from '../../../typeChecker/typeErrorChecker'
import { FatalSyntaxError } from '../../errors'
import {
  createAcornParserOptions,
  defaultBabelOptions,
  positionToSourceLocation
} from '../../utils'
import { SourceParser } from '..'
import TypeParser from './typeParser'
import { transformBabelASTToESTreeCompliantAST } from './utils'

export class SourceTypedParser extends SourceParser {
  parse(
    programStr: string,
    context: Context,
    options?: Partial<AcornOptions>,
    throwOnError?: boolean
  ): Program | null {
    // Parse with acorn type parser first to catch errors such as
    // import/export not at top level, trailing commas, missing semicolons
    try {
      TypeParser.parse(
        programStr,
        createAcornParserOptions(DEFAULT_ECMA_VERSION, context.errors, options)
      )
    } catch (error) {
      if (error instanceof SyntaxError) {
        error = new FatalSyntaxError(
          positionToSourceLocation((error as any).loc, options?.sourceFile),
          error.toString()
        )
      }

      if (throwOnError) throw error
      context.errors.push(error)
      return null
    }

    // Parse again with babel parser to capture all type syntax
    // and catch remaining syntax errors not caught by acorn type parser
    const ast = babelParse(programStr, {
      ...defaultBabelOptions,
      sourceFilename: options?.sourceFile,
      errorRecovery: throwOnError ?? true
    })

    if (ast.errors.length) {
      ast.errors
        .filter(error => error instanceof SyntaxError)
        .forEach(error => {
          context.errors.push(
            new FatalSyntaxError(
              positionToSourceLocation((error as any).loc, options?.sourceFile),
              error.toString()
            )
          )
        })

      return null
    }

    const typedProgram: TypedES.Program = ast.program as TypedES.Program
    console.log(typedProgram)
    if (context.prelude !== programStr) {
      // Check for any declaration only if the program is not the prelude
      checkForAnyDeclaration(typedProgram, context)
    }
    const typedCheckedProgram: Program = checkForTypeErrors(typedProgram, context)
    transformBabelASTToESTreeCompliantAST(typedCheckedProgram)

    return typedCheckedProgram
  }

  toString(): string {
    return 'SourceTypedParser'
  }
}

function checkForAnyDeclaration(program: TypedES.Program, context: Context) {
  const config = {
    allowAnyInVariables: false,
    allowAnyInParameters: false,
    allowAnyInReturnType: false,
    allowAnyInTypeAnnotationParameters: false,
    allowAnyInTypeAnnotationReturnType: false
  }

  function pushAnyUsageError(message: string, node: TypedES.Node) {
    if (node.loc) {
      context.errors.push(new FatalSyntaxError(node.loc, message))
    }
  }

  function isAnyType(node: TypedES.TSTypeAnnotation | undefined) {
    return node?.typeAnnotation?.type === 'TSAnyKeyword' || node?.typeAnnotation === undefined
  }

  function checkNode(node: TypedES.Node) {
    switch (node.type) {
      case 'VariableDeclaration': {
        if (!config.allowAnyInVariables) {
          node.declarations.forEach(decl => {
            const tsType = (decl as any).id?.typeAnnotation
            if (isAnyType(tsType)) {
              pushAnyUsageError('Usage of "any" in variable declaration is not allowed.', node)
            }
            if (decl.init) {
              // check for lambdas
              checkNode(decl.init)
            }
          })
        }
        break
      }
      case 'FunctionDeclaration': {
        if (!config.allowAnyInParameters || !config.allowAnyInReturnType) {
          const func = node as any
          // Check parameters
          if (!config.allowAnyInParameters) {
            func.params?.forEach((param: any) => {
              if (isAnyType(param.typeAnnotation)) {
                pushAnyUsageError('Usage of "any" in function parameter is not allowed.', param)
              }
            })
          }
          // Check return type
          if (!config.allowAnyInReturnType && isAnyType(func.returnType)) {
            pushAnyUsageError('Usage of "any" in function return type is not allowed.', node)
          }
          checkNode(node.body)
        }
        break
      }
      case 'ReturnStatement': {
        if (node.argument) {
          checkNode(node.argument)
        }
        break
      }
      case 'BlockStatement':
        node.body.forEach(checkNode)
        break
      default:
        break
    }
  }

  function checkTSNode(node: TypedES.Node) {
    if (!node) {
      // Happens when there is no type annotation
      // This should have been caught by checkNode function
      return
    }
    switch (node.type) {
      case 'VariableDeclaration': {
        if (!config.allowAnyInVariables) {
          node.declarations.forEach(decl => {
            const tsType = (decl as any).id?.typeAnnotation
            checkTSNode(tsType)
          })
        }
        break
      }
      case 'TSTypeAnnotation': {
        const annotation = node as TypedES.TSTypeAnnotation
        // If it's a function type annotation, check params and return
        if (annotation.typeAnnotation?.type === 'TSFunctionType') {
          annotation.typeAnnotation.parameters?.forEach(param => {
            // Recursively check nested TSTypeAnnotations in parameters
            if (param.typeAnnotation) {
              checkTSNode(param.typeAnnotation)
            }
          })
          const returnAnno = (annotation.typeAnnotation as TypedES.TSFunctionType).typeAnnotation
          if (!config.allowAnyInTypeAnnotationReturnType && isAnyType(returnAnno)) {
            pushAnyUsageError(
              'Usage of "any" in type annotation\'s function return type is not allowed.',
              annotation
            )
          }
          // Recursively check nested TSTypeAnnotations in return type
          checkTSNode(returnAnno)
        }
        break
      }
      case 'FunctionDeclaration': {
        // Here we also check param type annotations + return type via config
        if (!config.allowAnyInParameters || !config.allowAnyInReturnType) {
          const func = node as any
          // Check parameters
          if (!config.allowAnyInParameters) {
            func.params?.forEach((param: any) => {
              if (isAnyType(param.typeAnnotation)) {
                pushAnyUsageError('Usage of "any" in function parameter is not allowed.', param)
              }
              // Recursively check the annotation
              checkTSNode(param.typeAnnotation)
            })
          }
          // Recursively check the function return type annotation
          checkTSNode(func.returnType)
        }
        break
      }
      case 'BlockStatement':
        node.body.forEach(checkTSNode)
        break
      default:
        break
    }
  }

  if (!config.allowAnyInVariables || !config.allowAnyInParameters || !config.allowAnyInReturnType) {
    program.body.forEach(checkNode)
  }
  if (!config.allowAnyInTypeAnnotationParameters || !config.allowAnyInTypeAnnotationReturnType) {
    program.body.forEach(checkTSNode)
  }
}
